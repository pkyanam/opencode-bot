import { describe, expect, it, vi } from "vitest";
import { CloudflareUpdateApiClient } from "./cloudflare-update-api";

const account = "a".repeat(32);
const token = "control-secret";
function reply(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ message: `bad ${token}` }] }), { status, headers: { "content-type": "application/json" } });
}

describe("CloudflareUpdateApiClient", () => {
  it("uses the completion JWT for asset buckets and returns the final completion JWT", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init: init ?? {} });
      if (url.endsWith("assets-upload-session")) return reply({ buckets: [["abc"]], jwt: "session-jwt" });
      return reply({ jwt: "completion-jwt" });
    }) as unknown as typeof fetch;
    const client = new CloudflareUpdateApiClient(account, "worker", token, fetchImpl, "https://cf.test");
    const result = await client.uploadAssets({ "index.html": { hash: "abc", size: 3 } }, new Map([["index.html", new Uint8Array([65, 66, 67])] ]));
    expect(result).toBe("completion-jwt");
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer session-jwt");
    expect(calls[1].url).toContain("workers/assets/upload?base64=true");
  });

  it("preserves live settings bindings and only patches container configuration", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init: init ?? {} });
      if (url.endsWith("/settings")) return reply({ bindings: [{ name: "APP_TOKEN", type: "secret_text" }, { name: "PUBLIC_MODE", type: "plain_text", text: "public", value: "should-not-be-copied" }, { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "live-assets", resource_id: "r2-resource" }] });
      if (url.includes("/versions")) return reply({ id: "version-1" });
      if (url.includes("/applications/app-1")) return reply({ id: "app-1", configuration: { image: "new" } });
      return reply({});
    }) as unknown as typeof fetch;
    const client = new CloudflareUpdateApiClient(account, "worker", token, fetchImpl, "https://cf.test");
    const bundle = { schemaVersion: 1 as const, version: "v1.2.3", commit: "b".repeat(40), bundleSha256: "c".repeat(64), worker: { mainModule: "worker.js", modules: [{ name: "worker.js", contentBase64: btoa("export default {}"), contentType: "application/javascript+module" }], compatibilityDate: "2026-09-20", metadata: { bindings: [{ name: "APP_TOKEN", type: "secret_text" }], assets: { not_found_handling: "single-page-application", ignored: "drop-me" } } }, assets: [], computerImage: { reference: `docker.io/preethamk/opencode-bot@sha256:${"d".repeat(64)}`, digest: `sha256:${"d".repeat(64)}` }, runtime: { opencodeVersion: "2.0.11", sandboxVersion: "0.12.9" } };
    await client.uploadWorkerVersion({ bundle, assetsJwt: "assets-jwt" });
    const versionCall = calls.find((call) => call.url.includes("/versions"));
    const multipart = await new Response(versionCall?.init.body).formData();
    expect(JSON.parse(String(multipart.get("metadata"))).bindings).toEqual([{ name: "PUBLIC_MODE", type: "plain_text", text: "public" }, { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "live-assets", resource_id: "r2-resource" }]);
    expect(JSON.parse(String(multipart.get("metadata"))).keep_bindings).toEqual(["secret_text"]);
    expect(JSON.parse(String(multipart.get("metadata"))).assets).toEqual({ jwt: "assets-jwt", config: { not_found_handling: "single-page-application" } });
  });

  it("redacts the control token from API failures", async () => {
    const fetchImpl = vi.fn(async () => reply(null, 403)) as unknown as typeof fetch;
    const client = new CloudflareUpdateApiClient(account, "worker", token, fetchImpl, "https://cf.test");
    await expect(client.currentDeployment()).rejects.toThrow("[redacted]");
    await expect(client.currentDeployment()).rejects.not.toThrow(token);
  });

  it("redacts the bearer session JWT and uses Wrangler's single-asset upload mode", async () => {
    const payload = btoa(JSON.stringify({ wrangler_single_asset_uploads: true })).replaceAll("=", "");
    const sessionJwt = `header.${payload}.signature`;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init: init ?? {} });
      if (url.endsWith("assets-upload-session")) return reply({ buckets: [["abc"]], jwt: sessionJwt });
      return new Response(JSON.stringify({ success: false, result: null, errors: [{ message: `bad ${sessionJwt}` }] }), { status: 403 });
    }) as unknown as typeof fetch;
    const client = new CloudflareUpdateApiClient(account, "worker", token, fetchImpl, "https://cf.test");
    await expect(client.uploadAssets({ "app.js": { hash: "abc", size: 3 } }, new Map([["app.js", new Uint8Array([65, 66, 67])]]))).rejects.toThrow("[redacted]");
    expect(calls[1].url).toContain("/workers/assets/upload/abc");
    expect(calls[1].url).not.toContain(sessionJwt);
    expect(new Headers(calls[1].init.headers).get("content-type")).toBe("application/javascript");
    await expect(client.uploadAssets({ "app.js": { hash: "abc", size: 3 } }, new Map([["app.js", new Uint8Array([65, 66, 67])]]))).rejects.not.toThrow(sessionJwt);
  });

  it("passes a bounded abort signal to every API request", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return reply({ deployments: [] }); }) as unknown as typeof fetch;
    const client = new CloudflareUpdateApiClient(account, "worker", token, fetchImpl, "https://cf.test");
    await client.currentDeployment();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

it('reuses an accepted rollout after an interrupted receipt write', async () => {
  const rollout={id:'existing-rollout',description:'opencode-bot v1.2.3 (job-id)',target_configuration:{image:'pinned-image'},status:'completed'};
  const fetcher=vi.fn(async()=>reply([rollout])) as unknown as typeof fetch;
  const client=new CloudflareUpdateApiClient(account,'worker',token,fetcher,'https://cf.test');
  expect(await client.createContainerRollout('app-id',{description:rollout.description,target_configuration:rollout.target_configuration})).toEqual(rollout);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('calls the Workers fetch primitive without an application receiver', async () => {
  const fetcher = function(this: unknown) { expect(this).toBeUndefined(); return Promise.resolve(reply({deployments:[]})); } as typeof fetch;
  const client=new CloudflareUpdateApiClient(account,'worker',token,fetcher,'https://cf.test');
  await expect(client.currentDeployment()).resolves.toEqual({deploymentId:undefined,workerVersionId:undefined});
});
