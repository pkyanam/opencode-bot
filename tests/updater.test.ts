import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { resumeUpdate, type CloudflareUpdateApi, type ReleaseBundle, type UpdateJob, type UpdateLifecycle, type UpdateStore } from "../apps/control-worker/src/updater";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = new TextEncoder().encode("asset");
const bundle = (): ReleaseBundle => ({
  schemaVersion: 1, version: "v1.2.3", commit: "a".repeat(40), bundleSha256: "b".repeat(64),
  worker: { mainModule: "worker.js", modules: [{ name: "worker.js", contentBase64: "d29ya2Vy", contentType: "application/javascript" }], compatibilityDate: "2026-01-01", metadata: {} },
  assets: [{ path: "index.html", contentBase64: Buffer.from(bytes).toString("base64"), hash: "c".repeat(32), sha256: sha(bytes), size: bytes.byteLength }],
  computerImage: { reference: "docker.io/preethamk/opencode-bot@sha256:" + "d".repeat(64), digest: "sha256:" + "d".repeat(64) },
  runtime: { opencodeVersion: "2", sandboxVersion: "1" },
});

function harness(initial: Partial<UpdateJob> = {}) {
  let job: UpdateJob | null = { id: "u1", requestedVersion: "v1.2.3", phase: "queued", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...initial };
  const writes: UpdateJob[] = [];
  const calls: string[] = [];
  const store: UpdateStore = { read: async () => job, write: async (next) => { job = next; writes.push(next); } };
  const lifecycle: UpdateLifecycle = {
    assertIdle: async () => { calls.push("idle"); },
    checkpoint: async () => { calls.push("checkpoint"); return { id: "cp-1", sha256: "sha256:" + "e".repeat(64) }; },
    restore: async () => { calls.push("restore"); },
    healthCheck: async () => { calls.push("health"); },
  };
  const api: CloudflareUpdateApi = {
    currentDeployment: async () => ({ deploymentId: "dep-old", workerVersionId: "worker-old" }),
    uploadAssets: async (manifest, files) => { expect(Object.keys(manifest).every(path => path.startsWith("/"))).toBe(true); expect([...files.keys()]).toEqual(Object.keys(manifest)); calls.push("assets"); return "jwt"; },
    uploadWorkerVersion: async () => { calls.push("worker"); return { versionId: "worker-new" }; },
    promote: async () => { calls.push("promote"); return { deploymentId: "dep-new" }; },
    listContainerApplications: async () => [{ id: "app-1", name: "computer", configuration: { image: "docker.io/preethamk/opencode-bot@sha256:" + "0".repeat(64) } }],
    modifyContainerApplication: async (_id, body) => { calls.push("modify"); expect(Object.keys(body)).toEqual(["configuration"]); return { id: "app-1", name: "computer", configuration: body.configuration as Record<string, unknown> }; },
    createContainerRollout: async () => { calls.push("rollout"); return { id: "roll-1", status: "running" }; },
    getContainerRollout: async () => ({ id: "roll-1", status: "running" }),
    rollback: async () => { calls.push("rollback"); },
  };
  const options = { store, lifecycle, api, fetchBundle: async () => bundle(), workerName: "worker", containerName: "computer", now: () => "2026-01-01T00:00:01Z" };
  return { options, get job() { return job; }, writes, calls };
}

async function advance(h: ReturnType<typeof harness>, phases = 20) {
  for (let i = 0; i < phases && h.job && !["completed", "failed", "rollback_required"].includes(h.job.phase); i++) await resumeUpdate(h.options);
}

describe("resumable updater", () => {
  it("resumes from a recorded uploaded version without repeating upload or promotion", async () => {
    const h = harness({ phase: "promoting", uploadedWorkerVersionId: "worker-new", previous: { workerVersionId: "worker-old" } });
    await resumeUpdate(h.options);
    expect(h.calls).toEqual(["promote"]);
    expect(h.job?.phase).toBe("rolling_out_container");
  });

  it("rejects an invalid checkpoint before any asset or worker mutation", async () => {
    const h = harness({ phase: "checkpointing" });
    h.options.lifecycle.checkpoint = async () => ({ id: "", sha256: "" });
    await resumeUpdate(h.options);
    expect(h.job?.phase).toBe("failed");
    expect(h.calls).toEqual([]);
  });

  it("waits on unknown rollout status and never treats it as ready", async () => {
    const h = harness({ phase: "waiting_container", checkpointId: "cp-1", previous: { containerApplicationId: "app-1" }, containerRolloutId: "roll-1" });
    h.options.api.getContainerRollout = async () => ({ id: "roll-1", status: "mysterious" });
    await resumeUpdate(h.options);
    expect(h.job?.phase).toBe("waiting_container");
    expect(h.job?.rolloutWaitAttempts).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it("does not auto-rollback after promotion may have happened", async () => {
    const h = harness({ phase: "promoting", checkpointId: "cp-1", uploadedWorkerVersionId: "worker-new", previous: { workerVersionId: "worker-old" } });
    h.options.api.promote = async () => { throw new Error("promotion failed"); };
    await resumeUpdate(h.options);
    expect(h.job?.phase).toBe("rollback_required");
    expect(h.job?.resumePhase).toBe("promoting");
    expect(h.job?.checkpointId).toBe("cp-1");
    expect(h.calls).not.toContain("restore");
    expect(h.calls).not.toContain("rollback");
  });

  it("fails before promotion while retaining the checkpoint for recovery", async () => {
    const h = harness({ phase: "uploading_worker", checkpointId: "cp-1", assetsJwt: "jwt" });
    h.options.api.uploadWorkerVersion = async () => { throw new Error("upload failed"); };
    await resumeUpdate(h.options);
    expect(h.job?.phase).toBe("failed");
    expect(h.job?.resumePhase).toBeUndefined();
    expect(h.job?.checkpointId).toBe("cp-1");
    expect(h.calls).not.toContain("restore");
    expect(h.calls).not.toContain("rollback");
  });
});
