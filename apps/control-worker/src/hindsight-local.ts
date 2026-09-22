import { MemoryError } from "./memory-registry";

export type LocalHindsightOptions = {
  baseUrl?: string;
  token: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  fetcher?: typeof fetch;
  instance?: (id: string) => void;
};

export const HINDSIGHT_LOCAL_DEFAULT_TIMEOUT_MS = 120_000;
export const HINDSIGHT_LOCAL_REFLECT_TIMEOUT_MS = 330_000;
export const hindsightLocalTimeoutMs = (path: string) =>
  path.includes("/reflect") ? HINDSIGHT_LOCAL_REFLECT_TIMEOUT_MS : HINDSIGHT_LOCAL_DEFAULT_TIMEOUT_MS;

/** Adapter for the loopback supervisor (runner/hindsight-service.mjs).
 * Provider credentials are explicit inputs; this adapter never copies credentials from
 * another Hindsight endpoint or claims readiness from the supervisor's liveness probe. */
export class LocalHindsight {
  private checkedAt = 0;
  private instanceId?: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: LocalHindsightOptions) {
    if (!options.token) throw new MemoryError(503, "The local Hindsight supervisor token is not configured.");
    this.base = (options.baseUrl ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
    this.fetchImpl = options.fetcher ?? fetch;
    const provider = [options.llmBaseUrl, options.llmApiKey, options.llmModel].filter(value => value !== undefined);
    if (provider.length > 0 && provider.length !== 3) throw new MemoryError(400, "Local Hindsight requires llmBaseUrl, llmApiKey, and llmModel together.");
    if (options.llmBaseUrl && !/^https?:\/\//i.test(options.llmBaseUrl)) throw new MemoryError(400, "The local Hindsight LLM base URL must use http(s).");
  }
  private raw(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.token}`);
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    return this.fetchImpl(`${this.base}${path}`, { ...init, headers, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(hindsightLocalTimeoutMs(path)) });
  }
  private async publicHealth(): Promise<any> {
    let response: Response;
    try { response = await this.raw("/health"); } catch { throw new MemoryError(503, "The local Hindsight supervisor is unavailable."); }
    let body: any; try { body = await response.json(); } catch { body = undefined; }
    if (body?.instanceId && body.instanceId !== this.instanceId) { this.instanceId = body.instanceId; this.options.instance?.(body.instanceId); }
    if (!response.ok || body?.upstreamReady !== true) throw new MemoryError(503, "Local Hindsight is not ready; configure its LLM provider and wait for health.");
    return body;
  }
  private async prepare() {
    if (Date.now() - this.checkedAt < 5_000) return;
    if (this.options.llmBaseUrl) {
      {
        const configured = await this.raw("/configure", { method: "POST", body: JSON.stringify({ llmBaseUrl: this.options.llmBaseUrl, llmApiKey: this.options.llmApiKey, llmModel: this.options.llmModel }) });
        if (!configured.ok) throw new MemoryError(503, "Local Hindsight provider configuration failed.");
      }
    }
    await this.publicHealth();
    this.checkedAt = Date.now();
  }
  async health() { return this.publicHealth(); }
  async fetch(path: string, init: RequestInit = {}) { await this.prepare(); try { return await this.raw(path, init); } catch (error) { this.checkedAt = 0; throw error; } }
}
