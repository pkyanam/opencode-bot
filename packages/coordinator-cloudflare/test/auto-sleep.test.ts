import { describe, expect, it } from "vitest";
import { AutoSleepController, type PlannedComputerSleep, type PlannedSleepStore } from "../src/auto-sleep";
import { ComputerManager, type CheckpointPointerStore, type CommittedCheckpoint } from "../src/index";
import type { ComputerHandle, ComputerProvider } from "../../computer-cloudflare/src/index";

function harness() {
  const calls: string[] = [];
  const handle: ComputerHandle = {
    id: "shared", generation: 1, workspacePath: "/workspace/shared", runnerPort: 8787,
    status: { id: "shared", state: "ready", runner: "ready", generation: 1, checkedAt: "now" },
    transport: { computerId: "shared", generation: 1, fetch: async () => new Response(JSON.stringify({ instanceId: "runner-1" }), { status: 200 }) },
  };
  const provider: ComputerProvider = {
    capabilities: async () => ({ os: "linux", shell: true, desktop: false, browser: false, durableDisk: true, snapshots: false, enforcedEgress: false, maxParallelScreens: 0 }),
    ensure: async () => handle,
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
  return { calls, provider, checkpoints, markers, manager, pointer, get marker() { return marker; } };
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
});
