import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, mkdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";

const VERSION = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_ROOT = "/var/lib/opencode-bot/update";
function compareVersion(a: string, b: string) { const aa = a.slice(1).split(".").map(Number), bb = b.slice(1).split(".").map(Number); return aa[0]-bb[0] || aa[1]-bb[1] || aa[2]-bb[2]; }

export type ReleaseManifest = { version: string; commit: string; archive: { file: "boat-bundle.tar.gz"; sha256: string; size: number } };
export type UpdateJob = { id: string; requestedVersion: string; phase: "queued" | "running" | "completed" | "failed"; startedAt: string; updatedAt: string; error?: string; manifest?: string };

function validManifest(value: unknown): value is ReleaseManifest {
  const m = value as ReleaseManifest;
  return !!m && typeof m === "object" && VERSION.test(m.version) && COMMIT.test(m.commit) && !!m.archive && m.archive.file === "boat-bundle.tar.gz" && SHA256.test(m.archive.sha256) && Number.isSafeInteger(m.archive.size) && m.archive.size > 0;
}
async function hashFile(file: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
export async function verifyBundle(manifestPath: string): Promise<ReleaseManifest> {
  const path = resolve(manifestPath); const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!validManifest(manifest)) throw new Error("Invalid Boat release manifest");
  const archive = resolve(dirname(path), manifest.archive.file); const info = await stat(archive);
  if (info.size !== manifest.archive.size) throw new Error("Boat release size mismatch");
  if (await hashFile(archive) !== manifest.archive.sha256) throw new Error("Boat release checksum mismatch");
  return manifest;
}
type WorkspaceHooks = { assertIdle(): Promise<void>; setUpdating(value: boolean): void };

/** Unprivileged control-plane half of the Boat updater. It never downloads a release. */
export class BoatUpdater {
  private starting = false; private hooks?: WorkspaceHooks; private latest?: ReleaseManifest; private latestAt = 0;
  constructor(private readonly options: { statePath: string; currentRelease: string; setupScript?: string; bundleManifest?: string; bundleDir?: string; fetcher?: typeof fetch; assertIdle?: () => Promise<void>; privilegedStart?: () => Promise<void>; requestPath?: string }) {}
  attachWorkspace(hooks: WorkspaceHooks) { this.hooks = hooks; }
  async reconcile() {
    if (this.starting) return;
    const job = await this.readJob();
    if (job && (job.phase === 'queued' || job.phase === 'running') && Date.now() - Date.parse(job.updatedAt) > 32 * 60_000) {
      await this.writeJob({ ...job, phase: 'failed', error: 'The updater stopped before confirming completion. Check the service and retry.', updatedAt: new Date().toISOString() });
      this.hooks?.setUpdating(false);
    } else this.hooks?.setUpdating(Boolean(job && ['queued', 'running'].includes(job.phase)));
  }
  private async readJob(): Promise<UpdateJob | undefined> { try { return JSON.parse(await readFile(this.options.statePath, "utf8")) as UpdateJob; } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e; } }
  private async writeJob(job: UpdateJob) { await mkdir(dirname(this.options.statePath), { recursive: true }); const temp = `${this.options.statePath}.tmp-${process.pid}`; await writeFile(temp, JSON.stringify(job) + "\n", { mode: 0o600 }); await rename(temp, this.options.statePath); }
  private async latestManifest(): Promise<ReleaseManifest | undefined> {
    if (this.latest && Date.now() - this.latestAt < 60_000) return this.latest;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); timer.unref?.();
    try { const response = await (this.options.fetcher ?? fetch)("https://github.com/pkyanam/opencode-bot/releases/latest/download/boat-bundle-manifest.json", { signal: controller.signal }); if (!response.ok) throw new Error(`Could not check Boat releases (${response.status})`); const value: unknown = JSON.parse(await response.text()); if (!validManifest(value)) throw new Error("Invalid Boat release manifest"); this.latest = value; this.latestAt = Date.now(); return value; } finally { clearTimeout(timer); }
  }
  async status() {
    await this.reconcile();
    const job = await this.readJob(); let currentVersion = "unknown";
    try { const value: any = JSON.parse(await readFile(resolve(this.options.currentRelease, "boat-release.json"), "utf8")); if (value && VERSION.test(String(value.version))) currentVersion = String(value.version); } catch { /* transition/first install */ }
    let checkError: string | undefined;
    const latest = await this.latestManifest().catch((error) => { checkError = error instanceof Error ? error.message : "Release check failed"; return undefined; }); const latestVersion = latest?.version ?? job?.requestedVersion;
    if (job && (job.phase === "completed" || job.phase === "failed")) this.hooks?.setUpdating(false);
    return { currentVersion, latestVersion, available: !!latestVersion && VERSION.test(currentVersion) && compareVersion(latestVersion, currentVersion) > 0, configured: true, checkError, releaseUrl: latestVersion ? `https://github.com/pkyanam/opencode-bot/releases/tag/${latestVersion}` : undefined, host: "boat", managedExternally: false, ...(job ? { job } : {}) };
  }
  async start(version: unknown) {
    if (typeof version !== "string" || !VERSION.test(version)) throw new Error("A valid release version is required");
    if (this.starting) throw new Error("An update is already starting");
    this.starting = true;
    try {
    const old = await this.readJob(); if (old && (old.phase === "queued" || old.phase === "running")) throw new Error("An update is already in progress");
    if (!this.options.privilegedStart) throw new Error("Boat updater service is not configured");
    const priorStatus = await this.status();
    await (this.hooks?.assertIdle ?? this.options.assertIdle)?.(); this.hooks?.setUpdating(true);
    const now = new Date().toISOString(); const job: UpdateJob = { id: randomUUID(), requestedVersion: version, phase: "queued", startedAt: now, updatedAt: now };
    const requestPath = this.options.requestPath ?? `${RELEASE_ROOT}/state.json.request`;
    try { await this.writeJob(job); await mkdir(dirname(requestPath), { recursive: true }); const temporaryRequest = `${requestPath}.${job.id}.tmp`; await writeFile(temporaryRequest, JSON.stringify({ id: job.id, version }) + "\n", { mode: 0o600 }); await rename(temporaryRequest, requestPath); await this.options.privilegedStart(); }
    catch (e) { this.hooks?.setUpdating(false); await this.writeJob({ ...job, phase: "failed", updatedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }); throw e; }
    return { ...priorStatus, job, accepted: true };
    } finally { this.starting = false; }
  }
  async recover() { const job = await this.readJob(); if (!job || job.phase !== "failed") throw new Error("No failed Boat update is available to resume"); return this.start(job.requestedVersion); }
}
