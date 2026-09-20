import type {
  CheckpointManifest,
  ComputerHandle,
  ComputerProvider,
  ComputerSpec,
  RunnerTransport,
} from "../../computer-cloudflare/src/index";

export type CommittedCheckpoint = {
  manifest: CheckpointManifest;
  computerId: string;
  fence: number;
  committedAt: string;
  /** Runner instance observed when this pointer was committed. */
  runnerInstanceId?: string;
};

export interface CheckpointPointerStore {
  read(computerId: string): Promise<CommittedCheckpoint | null>;
  /** Called only after the provider has uploaded and verified the archive. */
  commit(pointer: CommittedCheckpoint): Promise<void>;
}

export type RunnerState = {
  instanceId?: string;
  fresh?: boolean;
  checkpointId?: string;
  activeRuns?: number;
};

export type ComputerReadiness = {
  handle: ComputerHandle;
  state: "ready" | "restore_required" | "state_unknown";
  committedCheckpoint?: CommittedCheckpoint;
  runnerState?: RunnerState;
  detail?: string;
};

export class CheckpointBusyError extends Error {
  override name = "CheckpointBusyError";
}

export class RestoreRequiredError extends Error {
  override name = "RestoreRequiredError";
}

/**
 * Coordinates the provider's ephemeral computer with a durable checkpoint
 * pointer. It intentionally leaves the pointer in application storage and
 * never treats a successful R2 upload as committed until `store.commit()` also
 * succeeds.
 */
export class ComputerManager {
  private readonly latestRunnerStates = new Map<string, RunnerState>();
  constructor(
    private readonly provider: ComputerProvider,
    private readonly store: CheckpointPointerStore,
  ) {}

  async prepare(spec: ComputerSpec, key?: string): Promise<ComputerReadiness> {
    const handle = await this.provider.ensure(spec, key);
    const committedCheckpoint = await this.store.read(spec.computerId);
    const transport = handle.transport;
    const runnerState = await this.readRunnerState(transport);
    this.latestRunnerStates.set(spec.computerId, runnerState);
    if (!committedCheckpoint) return { handle, state: "ready", runnerState };
    if (runnerState.fresh === true || (runnerState.instanceId && runnerState.instanceId !== committedCheckpoint.runnerInstanceId)) {
      return {
        handle,
        state: "restore_required",
        committedCheckpoint,
        runnerState,
        detail: "Runner instance differs from the committed checkpoint; restore is required before admitting a new session",
      };
    }
    if (!runnerState.instanceId) {
      return {
        handle,
        state: "state_unknown",
        committedCheckpoint,
        runnerState,
        detail: "Runner does not expose a checkpoint state or instance identity; refusing an automatic restore",
      };
    }
    return { handle, state: "ready", committedCheckpoint, runnerState };
  }

  async checkpoint(computerId: string, fence: number, activeRunCount: number, runnerInstanceId?: string): Promise<CommittedCheckpoint> {
    if (activeRunCount > 0) throw new CheckpointBusyError("Cannot checkpoint while a run is active");
    const manifest = await this.provider.checkpoint(computerId, fence);
    if (!manifest.supported || !manifest.durable) throw new Error(`Computer checkpoint is not durable: ${manifest.reason ?? "unsupported"}`);
    const pointer: CommittedCheckpoint = { manifest, computerId, fence, committedAt: new Date().toISOString(), runnerInstanceId };
    await this.store.commit(pointer);
    return pointer;
  }

  async restore(computerId: string, checkpoint?: CommittedCheckpoint): Promise<CommittedCheckpoint> {
    const pointer = checkpoint ?? await this.store.read(computerId);
    if (!pointer) throw new RestoreRequiredError(`No committed checkpoint exists for ${computerId}`);
    await this.provider.restore(computerId, pointer.manifest);
    // A replacement runner gets a new stable filesystem identity. Commit that
    // identity only after the archive has been restored, otherwise every later
    // prepare() would incorrectly request the same restore again.
    const runnerInstanceId = this.latestRunnerStates.get(computerId)?.instanceId ?? pointer.runnerInstanceId;
    const restored = runnerInstanceId && runnerInstanceId !== pointer.runnerInstanceId ? { ...pointer, runnerInstanceId, committedAt: new Date().toISOString() } : pointer;
    if (restored !== pointer) await this.store.commit(restored);
    return restored;
  }

  private async readRunnerState(transport: RunnerTransport): Promise<RunnerState> {
    const stateResponse = await transport.fetch("/checkpoint/state");
    if (stateResponse.ok) return parseRunnerState(await stateResponse.json());
    if (stateResponse.status !== 404) return {};
    const health = await transport.fetch("/health");
    if (!health.ok) return {};
    return parseRunnerState(await health.json());
  }
}

/** Cloudflare Durable Object storage implementation for the committed pointer. */
export class DurableObjectCheckpointStore implements CheckpointPointerStore {
  constructor(private readonly storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }, private readonly prefix = "computer-checkpoint") {}

  read(computerId: string): Promise<CommittedCheckpoint | null> {
    if (typeof this.storage.get !== "function") return Promise.resolve(null);
    return this.storage.get<CommittedCheckpoint>(`${this.prefix}:${computerId}`).then((value) => value ?? null);
  }

  async commit(pointer: CommittedCheckpoint): Promise<void> {
    if (typeof this.storage.put !== "function") return;
    await this.storage.put(`${this.prefix}:${pointer.computerId}`, pointer);
  }
}

function parseRunnerState(value: unknown): RunnerState {
  if (!value || typeof value !== "object") return {};
  const candidate = value as Record<string, unknown>;
  return {
    instanceId: typeof candidate.instanceId === "string" ? candidate.instanceId : undefined,
    fresh: candidate.fresh === true,
    checkpointId: typeof candidate.checkpointId === "string" ? candidate.checkpointId : undefined,
    activeRuns: typeof candidate.activeRuns === "number" ? candidate.activeRuns : undefined,
  };
}

export type { CheckpointManifest, ComputerHandle, ComputerProvider, ComputerSpec };
