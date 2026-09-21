import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "../apps/control-worker/src/update-controller";
import type { UpdateJob, UpdateLifecycle } from "../apps/control-worker/src/updater";

const release = { version: "v2.0.0", commit: "a".repeat(40), image: { reference: `docker.io/preethamk/opencode-bot@sha256:${"b".repeat(64)}` }, updater: { file: "app-bundle.json", sha256: "c".repeat(64), size: 10 } };
const lifecycle = (assertIdle = vi.fn(async () => {})): UpdateLifecycle => ({ assertIdle, checkpoint: vi.fn(), restore: vi.fn(), healthCheck: vi.fn() });
function harness(initial?: { job?: UpdateJob; config?: { accountId: string; workerName: string; token: string }; fetcher?: typeof fetch; idleError?: boolean }) {
  let job = initial?.job;
  let config = initial?.config;
  const writes: unknown[] = [];
  const schedule = vi.fn();
  const storage = { get: async <T>(key: string) => (key.endsWith("job") ? job : config) as T | undefined, put: async <T>(key: string, value: T) => { writes.push(value); if (key.endsWith("job")) job = value as UpdateJob; else config = value as typeof config; }, delete: async () => { config = undefined; } };
  const assertIdle = initial?.idleError ? vi.fn(async () => { throw new Error("active work"); }) : undefined;
  const controller = new UpdateController({ storage, currentVersion: "v1.0.0", identity: {}, lifecycle: lifecycle(assertIdle), schedule, fetcher: initial?.fetcher ?? (async () => new Response(JSON.stringify({schemaVersion: 2, ...release}))) });
  return { controller, schedule, writes, get job() { return job; } };
}
const baseJob = (phase: UpdateJob["phase"]): UpdateJob => ({ id: "job", requestedVersion: "v2.0.0", phase, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

describe("UpdateController", () => {
  it("never exposes the short-lived asset completion credential in status", async () => {
    const token = "asset-completion-secret";
    const h = harness({ job: { ...baseJob("uploading_worker"), assetsJwt: token } });
    const status = await h.controller.status();
    expect(status.job).toEqual(expect.not.objectContaining({ assetsJwt: token }));
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("blocks configuration changes while an update is active", async () => {
    const h = harness({ job: baseJob("downloading") });
    await expect(h.controller.configure({ accountId: "a", workerName: "w", token: "t".repeat(20) })).rejects.toThrow("current update");
    expect(h.writes).toHaveLength(0);
  });

  it("keeps the recovery lock when the runner is not idle", async () => {
    const h = harness({ job: { ...baseJob("rollback_required"), resumePhase: "promoting" }, config: { accountId: "a", workerName: "w", token: "t".repeat(20) }, idleError: true });
    await expect(h.controller.recover()).rejects.toThrow();
    expect(h.job?.phase).toBe("rollback_required");
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("refuses to start a second version while work is active", async () => {
    const h = harness({ job: baseJob("waiting_container"), config: { accountId: "a", workerName: "w", token: "t".repeat(20) } });
    await expect(h.controller.start("v2.0.1")).rejects.toThrow("already in progress");
    expect(h.schedule).not.toHaveBeenCalled();
  });
});
