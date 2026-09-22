import type {
  CheckpointPointerStore,
  CommittedCheckpoint,
  ComputerManager,
} from "./index";
import type {
  ComputerProvider,
  ComputerSpec,
} from "../../computer-cloudflare/src/index";

export type PlannedComputerSleep = {
  version: 1;
  computerId: string;
  checkpointId: string;
  runnerInstanceId?: string;
  phase: "planned" | "stopped";
  plannedAt: string;
  stoppedAt?: string;
};

export interface PlannedSleepStore {
  read(computerId: string): Promise<PlannedComputerSleep | null>;
  write(marker: PlannedComputerSleep): Promise<void>;
  clear(computerId: string): Promise<unknown>;
}

export type SleepGuards = {
  activeJobs(): Promise<number>;
  humanControlActive(): Promise<boolean>;
  nativeTerminalActive(): Promise<boolean>;
};

export type AutoSleepOptions = {
  manager: ComputerManager;
  provider: ComputerProvider;
  checkpoints: CheckpointPointerStore;
  markers: PlannedSleepStore;
  guards: SleepGuards;
  /** Optional application-owned R2/manifest verification before stop intent is committed. */
  verifyCheckpoint?(pointer: CommittedCheckpoint): Promise<void>;
};

/**
 * Opt-in checkpoint-before-stop lifecycle. This module deliberately does not
 * schedule itself: the owner chooses when to call sleep(), and supplies all
 * application activity guards. A marker in `planned` phase never authorizes an
 * automatic restore because the stop may not have completed.
 */
export class AutoSleepController {
  constructor(private readonly options: AutoSleepOptions) {}

  async sleep(spec: ComputerSpec, fence: number): Promise<PlannedComputerSleep> {
    await this.assertIdle();
    const existing = await this.options.markers.read(spec.computerId);
    if (existing) throw new Error(`Computer ${spec.computerId} already has a planned sleep (${existing.phase})`);

    const readiness = await this.options.manager.prepare(spec);
    if (readiness.state !== "ready") throw new Error(`Computer cannot be checkpointed while ${readiness.state}`);
    const pointer = await this.options.manager.checkpoint(spec.computerId, fence, 0, readiness.runnerState?.instanceId);
    // The checkpoint operation is asynchronous; recheck admission after it so
    // work that arrived during the archive cannot race the stop.
    await this.assertIdle();
    await this.options.verifyCheckpoint?.(pointer);
    await this.assertIdle();
    const marker: PlannedComputerSleep = {
      version: 1,
      computerId: spec.computerId,
      checkpointId: pointer.manifest.id,
      runnerInstanceId: pointer.runnerInstanceId,
      phase: "planned",
      plannedAt: new Date().toISOString(),
    };
    // Persist intent only after the checkpoint pointer is durably committed,
    // but before stopping the ephemeral runner.
    await this.options.markers.write(marker);
    await this.options.provider.stop(spec.computerId, "graceful");
    if (this.options.provider.isRunning && await this.options.provider.isRunning(spec.computerId)) throw new Error("Sandbox container is still running after stop");
    const stopped = { ...marker, phase: "stopped" as const, stoppedAt: new Date().toISOString() };
    await this.options.markers.write(stopped);
    return stopped;
  }

  async wake(spec: ComputerSpec): Promise<{ restored: boolean; marker?: PlannedComputerSleep }> {
    const marker = await this.options.markers.read(spec.computerId);
    if (!marker) {
      await this.options.provider.ensure(spec);
      // Recovery of an unplanned replacement is intentionally observational.
      // The caller may surface state_unknown/restore_required for a human.
      const readiness = await this.options.manager.prepare(spec);
      if (readiness.state !== "ready") throw new Error(`Computer wake requires recovery (${readiness.state})`);
      return { restored: false };
    }
    if (marker.phase !== "stopped") throw new Error("Computer sleep was planned but did not finish stopping; manual recovery is required");
    const pointer = await this.options.checkpoints.read(spec.computerId);
    if (!pointer || pointer.manifest.id !== marker.checkpointId) throw new Error("Planned sleep checkpoint is missing or no longer current");
    await this.options.provider.ensure(spec);
    // prepare() records the current runner identity for restore() and proves
    // that the replacement can accept requests. It does not authorize restore.
    await this.options.manager.prepare(spec);
    await this.options.manager.restore(spec.computerId, pointer);
    const ready = await this.options.manager.prepare(spec);
    if (ready.state !== "ready") throw new Error(`Computer restore did not become ready (${ready.state})`);
    await this.options.markers.clear(spec.computerId);
    return { restored: true, marker };
  }

  private async assertIdle(): Promise<void> {
    const [jobs, human, terminal] = await Promise.all([
      this.options.guards.activeJobs(),
      this.options.guards.humanControlActive(),
      this.options.guards.nativeTerminalActive(),
    ]);
    if (jobs > 0) throw new Error("Cannot sleep while a job is active");
    if (human) throw new Error("Cannot sleep while human desktop control is active");
    if (terminal) throw new Error("Cannot sleep while a native terminal is active");
  }
}
