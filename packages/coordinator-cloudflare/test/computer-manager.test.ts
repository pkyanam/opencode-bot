import { describe, expect, it } from "vitest";
import { CheckpointBusyError, ComputerManager, type CheckpointPointerStore, type CommittedCheckpoint } from "../src/index";
import type { ComputerHandle, ComputerProvider } from "../../computer-cloudflare/src/index";

function fakeProvider(state: Record<string, unknown>, calls: string[]): ComputerProvider {
  const handle: ComputerHandle = {
    id: "shared", generation: 7, workspacePath: "/workspace/shared", runnerPort: 8787,
    status: { id: "shared", state: "ready", runner: "ready", generation: 7, checkedAt: new Date().toISOString() },
    transport: { computerId: "shared", generation: 7, fetch: async (path) => new Response(JSON.stringify(path === "/health" ? state : state), { status: 200 }) },
  };
  return {
    capabilities: async () => ({ os: "linux", shell: true, desktop: false, browser: false, durableDisk: false, snapshots: false, enforcedEgress: false, maxParallelScreens: 0 }),
    ensure: async () => handle,
    inspect: async () => handle.status,
    connect: async () => handle.transport,
    checkpoint: async () => ({ id: "cp1", computerId: "shared", createdAt: new Date().toISOString(), supported: true, durable: true, checkpointKey: "k", sha256: "x" }),
    restore: async () => { calls.push("restore"); },
    stop: async () => undefined,
    destroy: async () => undefined,
  };
}

function store(initial: CommittedCheckpoint | null = null): CheckpointPointerStore & { value: CommittedCheckpoint | null } {
  return { value: initial, read: async function () { return this.value; }, commit: async function (pointer) { this.value = pointer; } };
}

describe("ComputerManager", () => {
  it("commits only durable checkpoints and blocks active runs", async () => {
    const calls: string[] = [];
    const pointers = store();
    const manager = new ComputerManager(fakeProvider({ instanceId: "i1" }, calls), pointers);
    await expect(manager.checkpoint("shared", 7, 1)).rejects.toBeInstanceOf(CheckpointBusyError);
    const pointer = await manager.checkpoint("shared", 7, 0, "i1");
    expect(pointer.manifest.checkpointKey).toBe("k");
    expect(pointers.value?.runnerInstanceId).toBe("i1");
  });

  it("requires explicit restore when the runner instance changes", async () => {
    const calls: string[] = [];
    const pointers = store({ manifest: { id: "cp1", computerId: "shared", createdAt: "now", supported: true, durable: true }, computerId: "shared", fence: 1, committedAt: "now", runnerInstanceId: "old" });
    const manager = new ComputerManager(fakeProvider({ instanceId: "new" }, calls), pointers);
    const readiness = await manager.prepare({ computerId: "shared", runnerToken: "token" });
    expect(readiness.state).toBe("restore_required");
    await manager.restore("shared");
    expect(calls).toEqual(["restore"]);
    expect(pointers.value?.runnerInstanceId).toBe("new");
    expect((await manager.prepare({ computerId: "shared", runnerToken: "token" })).state).toBe("ready");
  });

  it("does not turn a legacy pointer without lineage into a permanent restore loop", async () => {
    const calls: string[] = [];
    const pointers = store({ manifest: { id: "cp1", computerId: "shared", createdAt: "now", supported: true, durable: true }, computerId: "shared", fence: 1, committedAt: "now" });
    const manager = new ComputerManager(fakeProvider({ instanceId: "current" }, calls), pointers);
    expect((await manager.prepare({ computerId: "shared", runnerToken: "token" })).state).toBe("state_unknown");
    await manager.restore("shared");
    expect(pointers.value?.runnerInstanceId).toBe("current");
    expect((await manager.prepare({ computerId: "shared", runnerToken: "token" })).state).toBe("ready");
  });

  it("retains runner quiescence blocker fields for diagnostics", async () => {
    const manager = new ComputerManager(fakeProvider({ instanceId: "current", quiesced: false, humanControlActive: true, nativeTerminalActive: true, configuring: false, ownershipUncertain: false }, []), store());
    const readiness = await manager.prepare({ computerId: "shared", runnerToken: "token" });
    expect(readiness.runnerState).toMatchObject({ humanControlActive: true, nativeTerminalActive: true, configuring: false, ownershipUncertain: false });
  });
});
