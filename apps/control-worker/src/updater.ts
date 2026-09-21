/**
 * Resumable, control-plane-only application updater.
 *
 * This module deliberately knows nothing about the runner token or the UI.
 * The caller supplies lifecycle callbacks for idling/checkpointing/restoring
 * and persists the returned job after every phase so a DO alarm can resume it.
 */

export type UpdatePhase =
  | "queued" | "downloading" | "verified" | "quiescing" | "checkpointing"
  | "uploading_assets" | "uploading_worker" | "promoting"
  | "rolling_out_container" | "waiting_container" | "restoring"
  | "health_check" | "completed" | "failed" | "rollback_required";

export type ReleaseBundle = {
  schemaVersion: 1;
  version: string;
  commit: string;
  bundleSha256: string;
  worker: {
    requiredBindings?: Array<{ name: string; type: string }>;
    mainModule: string;
    modules: Array<{ name: string; contentBase64: string; contentType: string }>;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    metadata: Record<string, unknown>;
  };
  /** hash is Wrangler's 32-hex BLAKE3(content as base64 + extension). */
  assets: Array<{
    path: string;
    contentBase64: string;
    hash: string;
    sha256: string;
    size: number;
    contentType?: string;
  }>;
  computerImage: { reference: string; digest: string };
  runtime: { opencodeVersion: string; sandboxVersion: string };
};

export type UpdateJob = {
  id: string;
  requestedVersion: string;
  phase: UpdatePhase;
  startedAt: string;
  updatedAt: string;
  error?: string;
  bundle?: { version: string; commit: string; sha256: string };
  previous?: { deploymentId?: string; workerVersionId?: string; imageReference?: string; containerApplicationId?: string };
  checkpointId?: string;
  uploadedWorkerVersionId?: string;
  /** Short-lived asset completion JWT; stored only in the control-plane DO job. */
  assetsJwt?: string;
  deploymentId?: string;
  containerRolloutId?: string;
  rolloutWaitAttempts?: number;
  /** Phase to retry after an operator completes recovery from rollback_required. */
  resumePhase?: UpdatePhase;
};

export interface UpdateStore { read(): Promise<UpdateJob | null>; write(job: UpdateJob): Promise<void>; }

export interface UpdateLifecycle {
  assertIdle(): Promise<void>;
  checkpoint(): Promise<{ id: string; sha256: string }>;
  restore(checkpointId: string): Promise<void>;
  healthCheck(): Promise<void>;
}

export type ContainerApplication = {
  id: string;
  name: string;
  configuration?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface CloudflareUpdateApi {
  currentDeployment(): Promise<{ deploymentId?: string; workerVersionId?: string }>;
  uploadAssets(manifest: Record<string, { hash: string; size: number }>, files: Map<string, Uint8Array>): Promise<string>;
  uploadWorkerVersion(input: { bundle: ReleaseBundle; assetsJwt: string }): Promise<{ versionId: string }>;
  promote(versionId: string): Promise<{ deploymentId: string }>;
  listContainerApplications(name?: string): Promise<ContainerApplication[]>;
  modifyContainerApplication(id: string, body: Record<string, unknown>): Promise<ContainerApplication>;
  createContainerRollout(id: string, body: Record<string, unknown>): Promise<{ id?: string; status?: string; [key: string]: unknown }>;
  getContainerRollout(id: string, rolloutId: string): Promise<{ id?: string; status?: string; [key: string]: unknown }>;
  /** Must be idempotent: promote the recorded prior Worker version and restore its image. */
  rollback(previous: NonNullable<UpdateJob["previous"]>): Promise<void>;
}

export type UpdaterOptions = {
  store: UpdateStore;
  lifecycle: UpdateLifecycle;
  api: CloudflareUpdateApi;
  fetchBundle: (version: string) => Promise<ReleaseBundle>;
  workerName: string;
  containerName?: string;
  now?: () => string;
};

const terminal = new Set<UpdatePhase>(["completed", "failed", "rollback_required"]);
const fail = (message: string): never => { throw new Error(message); };

export function validateReleaseBundle(bundle: ReleaseBundle): void {
  if (bundle.schemaVersion !== 1 || !/^v\d+\.\d+\.\d+$/.test(bundle.version)) fail("unsupported release bundle");
  if (!/^[0-9a-f]{40}$/.test(bundle.commit) || !/^[0-9a-f]{64}$/.test(bundle.bundleSha256)) fail("invalid release identity");
  if (!bundle.worker?.mainModule || !bundle.worker.modules.some((m) => m.name === bundle.worker.mainModule)) fail("worker main module is missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bundle.worker.compatibilityDate)) fail("invalid compatibility date");
  if (!/^sha256:[0-9a-f]{64}$/.test(bundle.computerImage.digest) || !/^docker\.io\/preethamk\/opencode-bot@sha256:[0-9a-f]{64}$/.test(bundle.computerImage.reference) || !bundle.computerImage.reference.endsWith(bundle.computerImage.digest)) fail("container image must be the pinned OpenCode Bot Docker image");
  for (const asset of bundle.assets) {
    if (!asset.path || asset.path.startsWith("/") || asset.path.includes("..") || !/^[0-9a-f]{32}$/.test(asset.hash) || !/^[0-9a-f]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0) fail("invalid asset manifest entry");
    const bytes = decode(asset.contentBase64);
    if (bytes.byteLength !== asset.size) fail(`asset size mismatch: ${asset.path}`);
  }
}

async function verifyAssetHashes(bundle: ReleaseBundle): Promise<void> {
  for (const asset of bundle.assets) {
    const digest = await crypto.subtle.digest("SHA-256", decode(asset.contentBase64).buffer as ArrayBuffer);
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== asset.sha256) fail(`asset sha256 mismatch: ${asset.path}`);
  }
}

function decode(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return bytes;
}

function transition(job: UpdateJob, phase: UpdatePhase, now: () => string, extra: Partial<UpdateJob> = {}): UpdateJob {
  return { ...job, ...extra, phase, updatedAt: now(), error: undefined };
}

/** Execute one bounded phase. Call repeatedly from a Durable Object alarm. */
export async function resumeUpdate(options: UpdaterOptions): Promise<UpdateJob | null> {
  const now = options.now ?? (() => new Date().toISOString());
  let job = await options.store.read();
  if (!job || terminal.has(job.phase)) return job;
  try {
    if (job.phase === "queued") {
      job = transition(job, "downloading", now); await options.store.write(job); return job;
    }
    if (job.phase === "downloading") {
      const bundle = await options.fetchBundle(job.requestedVersion);
      validateReleaseBundle(bundle);
      await verifyAssetHashes(bundle);
      job = transition(job, "verified", now, { bundle: { version: bundle.version, commit: bundle.commit, sha256: bundle.bundleSha256 } });
      await options.store.write(job); return job;
    }
    const bundle = await options.fetchBundle(job.requestedVersion);
    validateReleaseBundle(bundle);
    await verifyAssetHashes(bundle);
    if (job.bundle && (job.bundle.version !== bundle.version || job.bundle.commit !== bundle.commit || job.bundle.sha256 !== bundle.bundleSha256)) fail("release bundle changed while update was in progress");
    if (job.phase === "verified") {
      const current = await options.api.currentDeployment();
      const apps = await options.api.listContainerApplications(options.containerName);
      const app = options.containerName ? apps.find((item) => item.name === options.containerName) : apps[0];
      if (!app?.id) fail("container application identity is missing");
      job = transition(job, "quiescing", now, { previous: { workerVersionId: current.workerVersionId, deploymentId: current.deploymentId, containerApplicationId: app?.id, imageReference: typeof app?.configuration?.image === "string" ? app.configuration.image : undefined } });
      await options.store.write(job); return job;
    }
    if (job.phase === "quiescing") { await options.lifecycle.assertIdle(); job = transition(job, "checkpointing", now); await options.store.write(job); return job; }
    if (job.phase === "checkpointing") {
      const checkpoint = await options.lifecycle.checkpoint();
      if (!checkpoint?.id || !/^[A-Za-z0-9._:-]{1,200}$/.test(checkpoint.id) || !/^sha256:[0-9a-f]{64}$/.test(checkpoint.sha256)) fail("checkpoint receipt is missing a valid id or sha256");
      job = transition(job, "uploading_assets", now, { checkpointId: checkpoint.id }); await options.store.write(job); return job;
    }
    if (job.phase === "uploading_assets") {
      const files = new Map(bundle.assets.map((asset) => [`/${asset.path}`, decode(asset.contentBase64)]));
      const manifest = Object.fromEntries(bundle.assets.map((asset) => [`/${asset.path}`, { hash: asset.hash, size: asset.size }]));
      const jwt = await options.api.uploadAssets(manifest, files);
      job = transition(job, "uploading_worker", now, { assetsJwt: jwt });
      await options.store.write(job); return job;
    }
    if (job.phase === "uploading_worker") {
      const jwt = job.assetsJwt;
      if (!jwt) fail("asset upload completion token is missing");
      const uploaded = await options.api.uploadWorkerVersion({ bundle, assetsJwt: jwt! });
      job = transition(job, "promoting", now, { uploadedWorkerVersionId: uploaded.versionId }); await options.store.write(job); return job;
    }
    if (job.phase === "promoting") {
      if (!job.uploadedWorkerVersionId) fail("worker version is missing");
      const promoted = await options.api.promote(job.uploadedWorkerVersionId!);
      job = transition(job, "rolling_out_container", now, { deploymentId: promoted.deploymentId }); await options.store.write(job); return job;
    }
    if (job.phase === "rolling_out_container") {
      const applicationId = job.previous?.containerApplicationId;
      if (!applicationId) fail("container application was not found");
      const apps = await options.api.listContainerApplications(options.containerName);
      const app = apps.find((item) => item.id === applicationId);
      if (!app) fail("container application disappeared");
      const application = app!;
      const configuration = { ...(application.configuration ?? {}), image: bundle.computerImage.reference };
      await options.api.modifyContainerApplication(application.id, { configuration });
      const rollout = await options.api.createContainerRollout(application.id, { description: `opencode-bot ${bundle.version} (${job.id})`, strategy: "rolling", target_configuration: configuration, step_percentage: 100, kind: "full_auto" });
      job = transition(job, "waiting_container", now, { containerRolloutId: rollout.id }); await options.store.write(job); return job;
    }
    if (job.phase === "waiting_container") {
      if (!job.previous?.containerApplicationId || !job.containerRolloutId) fail("container rollout is missing");
      const rollout = await options.api.getContainerRollout(job.previous!.containerApplicationId!, job.containerRolloutId!);
      const target = rollout.target_configuration as { image?: string } | undefined;
      if (target?.image && target.image !== bundle.computerImage.reference) fail("container rollout targets a different release image");
      const status = typeof rollout.status === "string" ? rollout.status.trim().toLowerCase() : "";
      if (["failed", "error", "cancelled", "canceled", "rejected", "reverted", "replaced"].includes(status)) fail(`container rollout ${status}`);
      if (!["complete", "completed", "succeeded"].includes(status)) {
        const attempts = (job.rolloutWaitAttempts ?? 0) + 1;
        if (attempts > 120) fail("container rollout timed out");
        await options.store.write({ ...job, rolloutWaitAttempts: attempts, updatedAt: now() }); return job;
      }
      job = transition(job, "restoring", now); await options.store.write(job); return job;
    }
    if (job.phase === "restoring") { if (job.checkpointId) await options.lifecycle.restore(job.checkpointId); job = transition(job, "health_check", now); await options.store.write(job); return job; }
    if (job.phase === "health_check") { await options.lifecycle.healthCheck(); job = transition(job, "completed", now); await options.store.write(job); return job; }
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Once promotion may have happened, automatic rollback is unsafe: it can
    // race a provider-side rollout and restore the checkpoint into a runner
    // whose image has already changed. Leave the checkpoint and maintenance
    // fence intact for an operator-driven recovery action.
    const promotionMayHaveHappened = ["promoting", "rolling_out_container", "waiting_container", "restoring", "health_check"].includes(job.phase);
    job = {
      ...job,
      phase: promotionMayHaveHappened ? "rollback_required" : "failed",
      resumePhase: promotionMayHaveHappened ? job.phase : undefined,
      error: message,
      updatedAt: now(),
    };
    await options.store.write(job); return job;
  }
}
