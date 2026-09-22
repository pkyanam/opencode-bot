import { CloudflareUpdateApiClient } from "./cloudflare-update-api";
import { fetchUpdateBundle, fetchUpdateRelease, newerVersion, type UpdateRelease } from "./update-releases";
import { resumeUpdate, type UpdateJob, type UpdateLifecycle } from "./updater";

type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<unknown> };
type Configuration = { accountId: string; workerName: string; token: string };
export const updateIsActive = (job?: UpdateJob | null) => Boolean(job && !["completed", "failed"].includes(job.phase));
const jobKey = "app-update:job";
const configKey = "app-update:configuration";
export class UpdateController {
  private release?: UpdateRelease;
  private checkedAt = 0;
  private bundleCache?: Awaited<ReturnType<typeof fetchUpdateBundle>>;
  private running = false;
  constructor(private readonly options: {
    storage: Storage;
    currentVersion: string;
    identity: { accountId?: string; workerName?: string };
    lifecycle: UpdateLifecycle;
    schedule: () => void;
    fetcher?: typeof fetch;
  }) {}
  private get fetcher() { return this.options.fetcher ?? fetch; }
  async job() { return (await this.options.storage.get<UpdateJob>(jobKey)) ?? null; }
  async active() { return updateIsActive(await this.job()); }
  private config() { return this.options.storage.get<Configuration>(configKey); }
  private client(c: Configuration) { return new CloudflareUpdateApiClient(c.accountId, c.workerName, c.token, this.fetcher); }
  private async latest(force = false) {
    if (!this.release || force || Date.now() - this.checkedAt > 60_000) {
      this.release = await fetchUpdateRelease(undefined, this.fetcher);
      this.checkedAt = Date.now();
    }
    return this.release;
  }
  async status(force = false) {
    const config = await this.config();
    const job = await this.job();
    let latest: UpdateRelease | undefined; let checkError: string | undefined;
    try { latest = await this.latest(force); } catch { checkError = "Could not check the release server. Try again shortly."; }
    const publicJob = job ? (({ assetsJwt, ...rest }) => rest)(job) : undefined;
    return {
      currentVersion: `v${this.options.currentVersion.replace(/^v/, "")}`,
      latestVersion: latest?.version,
      available: Boolean(latest?.updater && newerVersion(latest.version, this.options.currentVersion)),
      configured: Boolean(config),
      configuration: { accountId: config?.accountId ?? this.options.identity.accountId ?? "", workerName: config?.workerName ?? this.options.identity.workerName ?? "" },
      job: publicJob,
      releaseUrl: latest ? `https://github.com/pkyanam/opencode-bot/releases/tag/${latest.version}` : undefined,
      ...(checkError ? { checkError } : {}),
    };
  }
  async configure(value: unknown) {
    if (await this.active() && (await this.job())?.phase !== "rollback_required") throw new Error("Wait for the current update to finish before changing update access.");
    const input = value as Partial<Configuration>;
    if (!input || typeof input.accountId !== "string" || typeof input.workerName !== "string" || typeof input.token !== "string" || input.token.length < 20 || input.token.length > 4096) throw new Error("Enter a Cloudflare account, Worker name, and deployment token.");
    const config = { accountId: input.accountId.trim(), workerName: input.workerName.trim(), token: input.token.trim() };
    if (this.options.identity.accountId && config.accountId !== this.options.identity.accountId) throw new Error("Use the Cloudflare account that hosts this app.");
    if (this.options.identity.workerName && config.workerName !== this.options.identity.workerName) throw new Error("Use this app’s Worker name.");
    const client = this.client(config);
    const deployment = await client.currentDeployment();
    const apps = await client.listContainerApplications(`${config.workerName}-sandbox`);
    if (!deployment.workerVersionId || !apps.some(app => app.name === `${config.workerName}-sandbox`)) throw new Error("The token could not find this app and its computer. Check its account and permissions.");
    await this.options.storage.put(configKey, config);
    return this.status();
  }
  async removeConfiguration() {
    if (await this.active()) throw new Error("Wait for the current update to finish before removing update access.");
    await this.options.storage.delete(configKey);
    return this.status();
  }
  async start(version: unknown) {
    const old = await this.job();
    if (updateIsActive(old)) {
      if (old?.requestedVersion === version) return this.status();
      throw new Error("An app update is already in progress.");
    }
    if (!await this.config()) throw new Error("Enable update access first.");
    const release = await this.latest(true);
    if (version !== release.version || !release.updater || !newerVersion(release.version, this.options.currentVersion)) throw new Error("There is no newer compatible release to install.");
    await this.options.lifecycle.assertIdle();
    const now = new Date().toISOString();
    await this.options.storage.put<UpdateJob>(jobKey, { id: crypto.randomUUID(), requestedVersion: release.version, phase: "queued", startedAt: now, updatedAt: now });
    this.options.schedule();
    return this.status();
  }
  async recover() {
    const job = await this.job();
    if (job?.phase !== "rollback_required" || !job.resumePhase) throw new Error("There is no paused update to resume.");
    if (!await this.config()) throw new Error("Restore update access first.");
    await this.options.lifecycle.assertIdle();
    // A health check can run against a replacement runner before its restored
    // checkpoint identity is visible. Re-enter restoring when a retained
    // checkpoint exists so the next alarm repairs state before checking health.
    const phase = job.resumePhase === "health_check" && job.checkpointId ? "restoring" : job.resumePhase;
    await this.options.storage.put(jobKey, { ...job, phase, error: undefined, rolloutWaitAttempts: 0, replacementWaitAttempts: 0, updatedAt: new Date().toISOString() });
    this.options.schedule();
    return this.status();
  }
  async resume() {
    if (this.running) return;
    const current = await this.job();
    if (!updateIsActive(current) || current?.phase === "rollback_required") return;
    const config = await this.config();
    if (!config) throw new Error("Update access is unavailable.");
    this.running = true;
    this.options.schedule(); // A replacement Worker must have an alarm to resume this job.
    try {
      await resumeUpdate({
        store: { read: () => this.job(), write: value => this.options.storage.put(jobKey, value) },
        lifecycle: this.options.lifecycle,
        api: this.client(config),
        workerName: config.workerName,
        containerName: `${config.workerName}-sandbox`,
        fetchBundle: async version => {
          if (this.bundleCache?.version !== version) this.bundleCache = await fetchUpdateBundle(version, this.fetcher);
          return this.bundleCache;
        },
      });
    } finally {
      this.running = false;
      if (await this.active()) this.options.schedule();
    }
  }
}
