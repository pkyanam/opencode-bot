import { describe, expect, it } from "vitest";
import { AutoSleepController, type PlannedComputerSleep, type PlannedSleepStore } from "../src/auto-sleep";
import { ComputerManager, type CheckpointPointerStore, type CommittedCheckpoint } from "../src/index";
import type { ComputerHandle, ComputerProvider } from "../../computer-cloudflare/src/index";

function harness() {
  const calls: string[] = [];
  let ensures = 0;
  const handle: ComputerHandle = {
    id: "shared", generation: 1, workspacePath: "/workspace/shared", runnerPort: 8787,
    status: { id: "shared", state: "ready", runner: "ready", generation: 1, checkedAt: "now" },
    transport: { computerId: "shared", generation: 1, fetch: async () => new Response(JSON.stringify({ instanceId: "runner-1" }), { status: 200 }) },
  };
  const provider: ComputerProvider = {
    capabilities: async () => ({ os: "linux", shell: true, desktop: false, browser: false, durableDisk: true, snapshots: false, enforcedEgress: false, maxParallelScreens: 0 }),
    ensure: async () => { ensures += 1; return handle; },
    inspect: async () => handle.status,
    connect: async () => handle.transport,
    checkpoint: async () => ({ id: "shared:1:0", computerId: "shared", createdAt: "now", supported: true, durable: true }),
    restore: async () => { calls.push("restore"); },
    stop: async () => { calls.push("stop"); },
    destroy: async () => undefined,
  };
  const pointer: CommittedCheckpoint = { manifest: { id: "checkpoint-1", computerId: "shared", createdAt: "now", supported: true, durable: true, checkpointKey: "key" }, computerId: "shared", fence: 1, committedAt: "now", runnerInstanceId: "runner-1" };
  const checkpoints: CheckpointPointerStore & { value: CommittedCheckpoint | null } = { value: null, read: async function () { return this.value; }, commit: async function (value) { this.value = value; } };
  let marker: PlannedComputerSleep | null = null;
  const markers: PlannedSleepStore = { read: async () => marker, write: async (value) => { marker = value; }, clear: async () => { marker = null; } };
  const manager = new ComputerManager(provider, checkpoints);
  return { calls, provider, checkpoints, markers, manager, pointer, get marker() { return marker; }, get ensures() { return ensures; } };
}

describe("AutoSleepController", () => {
  it("checkpoints and records stopped intent before stopping", async () => {
    const h = harness();
    const controller = new AutoSleepController({ manager: h.manager, provider: h.provider, checkpoints: h.checkpoints, markers: h.markers, guards: { activeJobs: async () => 0, humanControlActive: async () => false, nativeTerminalActive: async () => false } });
    const result = await controller.sleep({ computerId: "shared", runnerToken: "token" }, 1);
    expect(result.phase).toBe("stopped");
    expect(h.calls).toEqual(["stop"]);
    expect(h.marker?.checkpointId).toBe("shared:1:0");
  });

  it("refuses active work and never starts a planned restore", async () => {
    const h = harness();
    const controller = new AutoSleepController({ manager: h.manager, provider: h.provider, checkpoints: h.checkpoints, markers: h.markers, guards: { activeJobs: async () => 1, humanControlActive: async () => false, nativeTerminalActive: async () => false } });
    await expect(controller.sleep({ computerId: "shared", runnerToken: "token" }, 1)).rejects.toThrow("job is active");
    expect(h.calls).toEqual([]);
    await expect(controller.wake({ computerId: "shared", runnerToken: "token" })).resolves.toMatchObject({ restored: false });
    expect(h.calls).toEqual([]);
  });

  it("rechecks guards after the checkpoint before committing stop intent", async () => {
    const h = harness();
    let checks = 0;
    let verified = false;
    const controller = new AutoSleepController({
      manager: h.manager,
      provider: h.provider,
      checkpoints: h.checkpoints,
      markers: h.markers,
      verifyCheckpoint: async () => { verified = true; },
      guards: { activeJobs: async () => (++checks > 1 ? 1 : 0), humanControlActive: async () => false, nativeTerminalActive: async () => false },
    });
    await expect(controller.sleep({ computerId: "shared", runnerToken: "token" }, 1)).rejects.toThrow("job is active");
    expect(checks).toBe(2);
    expect(verified).toBe(false);
    expect(h.marker).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("rejects ambiguous or missing planned wake before ensuring a container", async () => {
    const planned = harness();
    await planned.markers.write({ version: 1, computerId: "shared", checkpointId: "checkpoint-1", phase: "planned", plannedAt: "now" });
    const plannedController = new AutoSleepController({ manager: planned.manager, provider: planned.provider, checkpoints: planned.checkpoints, markers: planned.markers, guards: { activeJobs: async () => 0, humanControlActive: async () => false, nativeTerminalActive: async () => false } });
    await expect(plannedController.wake({ computerId: "shared", runnerToken: "token" })).rejects.toThrow("manual recovery");
    expect(planned.ensures).toBe(0);

    const missing = harness();
    await missing.markers.write({ version: 1, computerId: "shared", checkpointId: "missing", phase: "stopped", plannedAt: "now" });
    const missingController = new AutoSleepController({ manager: missing.manager, provider: missing.provider, checkpoints: missing.checkpoints, markers: missing.markers, guards: { activeJobs: async () => 0, humanControlActive: async () => false, nativeTerminalActive: async () => false } });
    await expect(missingController.wake({ computerId: "shared", runnerToken: "token" })).rejects.toThrow("checkpoint is missing");
    expect(missing.ensures).toBe(0);
  });
});
