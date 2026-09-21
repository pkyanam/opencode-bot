import type { CloudflareUpdateApi, ContainerApplication, ReleaseBundle, UpdateJob } from "./updater";

type CfEnvelope<T> = { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }> };
const REQUEST_TIMEOUT_MS = 30_000;

/** Minimal REST adapter used by the updater. The API token is retained only by this instance. */
export class CloudflareUpdateApiClient implements CloudflareUpdateApi {
  private readonly root: string;
  constructor(
    private readonly accountId: string,
    private readonly scriptName: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    apiBase = "https://api.cloudflare.com/client/v4",
  ) {
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("invalid Cloudflare account id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(scriptName)) throw new Error("invalid Worker name");
    if (!apiToken) throw new Error("Cloudflare updater token is required");
    this.root = apiBase.replace(/\/$/, "");
  }

  private async request<T>(path: string, init: RequestInit = {}, bearer = this.apiToken): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    const fetcher = this.fetchImpl;
    try { response = await fetcher(`${this.root}${path}`, { ...init, headers, signal }); }
    catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      const safe = [this.apiToken, bearer].filter(Boolean).reduce((message, secret) => message.replaceAll(secret, "[redacted]"), detail).slice(0, 300);
      throw new Error(`Cloudflare API request failed: ${safe}`);
    }
    let payload: CfEnvelope<T> | undefined;
    try { payload = await response.json() as CfEnvelope<T>; } catch { /* status below is sufficient */ }
    if (!response.ok || !payload?.success) {
      const detail = payload?.errors?.map((item) => item.message).filter(Boolean).join("; ") ?? `HTTP ${response.status}`;
      const safe = [this.apiToken, bearer].filter(Boolean).reduce((message, secret) => message.replaceAll(secret, "[redacted]"), detail).slice(0, 500);
      throw new Error(`Cloudflare API request failed: ${safe}`);
    }
    return payload.result;
  }

  private scripts(path: string): string { return `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(this.scriptName)}${path}`; }
  private containers(path: string): string { return `/accounts/${this.accountId}/containers${path}`; }

  async currentDeployment(): Promise<{ deploymentId?: string; workerVersionId?: string }> {
    const result = await this.request<{ deployments?: Array<{ id?: string; versions?: Array<{ version_id?: string; percentage?: number }> }> }>(this.scripts("/deployments"));
    const latest = result.deployments?.[0];
    return { deploymentId: latest?.id, workerVersionId: latest?.versions?.find((version) => version.percentage === 100)?.version_id ?? latest?.versions?.[0]?.version_id };
  }

  async uploadAssets(manifest: Record<string, { hash: string; size: number }>, files: Map<string, Uint8Array>): Promise<string> {
    const session = await this.request<{ buckets: string[][]; jwt?: string }>(this.scripts("/assets-upload-session"), { method: "POST", body: JSON.stringify({ manifest }) });
    const buckets = session.buckets ?? [];
    if (!session.jwt) throw new Error("Cloudflare asset upload did not return a JWT");
    let completionJwt = session.jwt;
    const singleAssetUploads = isSingleAssetUploadMode(session.jwt);
    for (const bucket of buckets) {
      if (singleAssetUploads) {
        for (const hash of bucket) {
          const entry = Object.entries(manifest).find(([, value]) => value.hash === hash);
          if (!entry) throw new Error("Cloudflare requested an unknown asset hash");
          const bytes = files.get(entry[0]);
          if (!bytes) throw new Error(`asset content is missing: ${entry[0]}`);
          const uploaded = await this.request<{ jwt?: string }>(`/accounts/${this.accountId}/workers/assets/upload/${encodeURIComponent(hash)}`, { method: "POST", body: bytes as unknown as BodyInit, headers: { "content-type": contentTypeForPath(entry[0]) } }, session.jwt);
          if (uploaded.jwt) completionJwt = uploaded.jwt;
        }
        continue;
      }
      const form = new FormData();
      for (const hash of bucket) {
        const entry = Object.entries(manifest).find(([, value]) => value.hash === hash);
        if (!entry) throw new Error("Cloudflare requested an unknown asset hash");
        const bytes = files.get(entry[0]);
        if (!bytes) throw new Error(`asset content is missing: ${entry[0]}`);
        const encoded = bytesToBase64(bytes);
        form.append(hash, new File([encoded], hash, { type: contentTypeForPath(entry[0]) }), hash);
      }
      const uploaded = await this.request<{ jwt?: string }>(`/accounts/${this.accountId}/workers/assets/upload?base64=true`, { method: "POST", body: form }, session.jwt);
      if (uploaded.jwt) completionJwt = uploaded.jwt;
    }
    return completionJwt;
  }

  async uploadWorkerVersion(input: { bundle: ReleaseBundle; assetsJwt: string }): Promise<{ versionId: string }> {
    const form = new FormData();
    const settings = await this.getSettings();
    this.validateBindings(settings, input.bundle);
    const configuredAssets = input.bundle.worker.metadata.assets as Record<string, unknown> | undefined;
    const assetConfig = configuredAssets?.config && typeof configuredAssets.config === "object" ? configuredAssets.config : configuredAssets;
    const metadata = { ...input.bundle.worker.metadata, main_module: input.bundle.worker.mainModule, compatibility_date: input.bundle.worker.compatibilityDate, ...(input.bundle.worker.compatibilityFlags ? { compatibility_flags: input.bundle.worker.compatibilityFlags } : {}), bindings: sanitizeBindings(settings.bindings).map(binding => binding.type === "plain_text" && binding.name === "OPENCODE_VERSION" ? { ...binding, text: input.bundle.runtime.opencodeVersion } : binding.type === "plain_text" && binding.name === "SANDBOX_PACKAGE_VERSION" ? { ...binding, text: input.bundle.runtime.sandboxVersion } : binding), keep_bindings: ["secret_text"], assets: { jwt: input.assetsJwt, ...(assetConfig && typeof assetConfig === "object" ? { config: sanitizeAssetConfig(assetConfig as Record<string, unknown>) } : {}) } };
    form.set("metadata", JSON.stringify(metadata));
    for (const module of input.bundle.worker.modules) form.set(module.name, new File([decode(module.contentBase64).buffer as ArrayBuffer], module.name, { type: module.contentType }));
    const result = await this.request<{ id?: string }>(this.scripts("/versions?bindings_inherit=strict"), { method: "POST", body: form });
    if (!result.id) throw new Error("Cloudflare did not return a Worker version id");
    return { versionId: result.id };
  }

  private async getSettings(): Promise<{ bindings?: Array<Record<string, unknown>>; [key: string]: unknown }> {
    return this.request(this.scripts("/settings"));
  }

  /** Fetches live settings and verifies the release cannot drop a live binding. */
  async validateConfiguration(bundle: ReleaseBundle, containerName?: string): Promise<{ settings: { bindings?: Array<Record<string, unknown>> }; container?: ContainerApplication }> {
    const settings = await this.getSettings();
    this.validateBindings(settings, bundle);
    const applications = await this.listContainerApplications(containerName);
    const container = containerName ? applications.find((item) => item.name === containerName) : applications[0];
    if (containerName && !container) throw new Error(`container application not found: ${containerName}`);
    return { settings, container };
  }

  /** Rejects a release which would silently drop a live binding or change its resource. */
  private validateBindings(settings: { bindings?: Array<Record<string, unknown>> }, bundle: ReleaseBundle): void {
    const live = settings.bindings ?? [];
    const expected = bundle.worker.requiredBindings ?? (Array.isArray(bundle.worker.metadata.bindings) ? bundle.worker.metadata.bindings as Array<Record<string, unknown>> : []);
    for (const binding of expected) {
      const name = typeof binding.name === "string" ? binding.name : "";
      if (!name) continue;
      const found = live.find((item) => item.name === name);
      if (!found || found.type !== binding.type) throw new Error(`release binding mismatch: ${name}`);
    }
    for (const binding of live) {
      if (typeof binding.name !== "string" || !binding.name) throw new Error("Cloudflare returned an invalid binding");
    }
  }

  async promote(versionId: string): Promise<{ deploymentId: string }> {
    const result = await this.request<{ id?: string }>(this.scripts("/deployments"), { method: "POST", body: JSON.stringify({ strategy: "percentage", versions: [{ percentage: 100, version_id: versionId }], annotations: { "workers/message": "opencode-bot updater" } }) });
    if (!result.id) throw new Error("Cloudflare did not return a deployment id");
    return { deploymentId: result.id };
  }

  async listContainerApplications(name?: string): Promise<ContainerApplication[]> {
    const query = name ? `?name=${encodeURIComponent(name)}` : "";
    const result = await this.request<ContainerApplication[]>(this.containers(`/applications${query}`));
    return Array.isArray(result) ? result : [];
  }

  async modifyContainerApplication(id: string, body: Record<string, unknown>): Promise<ContainerApplication> {
    const configuration = body.configuration;
    if (!configuration || typeof configuration !== "object") throw new Error("container configuration is missing");
    return this.request<ContainerApplication>(this.containers(`/applications/${encodeURIComponent(id)}`), { method: "PATCH", body: JSON.stringify({ configuration }) });
  }

  async createContainerRollout(id: string, body: Record<string, unknown>): Promise<{ id?: string; status?: string; [key: string]: unknown }> {
    const path = this.containers(`/applications/${encodeURIComponent(id)}/rollouts`);
    // An alarm can be interrupted after Cloudflare accepted a rollout but before
    // its ID was persisted. Reuse this job's rollout instead of replacing it.
    if (typeof body.description === "string" && body.description.includes("(")) {
      const rollouts = await this.request<Array<{ id?: string; status?: string; description?: string; target_configuration?: { image?: string } }>>(path);
      const existing = Array.isArray(rollouts) ? rollouts.find(rollout => rollout.description === body.description && rollout.target_configuration?.image === (body.target_configuration as { image?: string })?.image) : undefined;
      if (existing?.id) return existing;
    }
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  async getContainerRollout(id: string, rolloutId: string): Promise<{ id?: string; status?: string; [key: string]: unknown }> {
    return this.request(this.containers(`/applications/${encodeURIComponent(id)}/rollouts/${encodeURIComponent(rolloutId)}`));
  }

  async rollback(previous: NonNullable<UpdateJob["previous"]>): Promise<void> {
    if (previous.workerVersionId) await this.promote(previous.workerVersionId);
    if (previous.containerApplicationId && previous.imageReference) {
      const app = (await this.listContainerApplications()).find((item) => item.id === previous.containerApplicationId);
      if (!app) throw new Error("previous container application was not found");
      const configuration = { ...(app.configuration ?? {}), image: previous.imageReference };
      await this.modifyContainerApplication(app.id, { configuration });
      await this.createContainerRollout(app.id, { description: "opencode-bot rollback", strategy: "rolling", target_configuration: configuration, step_percentage: 100, kind: "full_auto" });
    }
  }
}

function decode(value: string): Uint8Array { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function bytesToBase64(bytes: Uint8Array): string { let output = ""; for (let index = 0; index < bytes.length; index += 0x8000) output += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(output); }
function sanitizeBindings(bindings: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  return (bindings ?? [])
    .filter((binding) => binding.type !== "secret_text")
    .map((binding) => Object.fromEntries(Object.entries(binding).filter(([key]) => !["value", "secret", "token"].includes(key))));
}

function isSingleAssetUploadMode(jwt: string): boolean {
  try {
    const encoded = jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    return payload.wrangler_single_asset_uploads === true;
  } catch { return false; }
}

function contentTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ({ ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".txt": "text/plain" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function sanitizeAssetConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => ["html_handling", "not_found_handling", "run_worker_first", "_redirects", "_headers"].includes(key)));
}
