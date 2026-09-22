import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/api";

const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
}

afterEach(() => vi.unstubAllGlobals());

describe("owned-node file client", () => {
  it("resolves a workspace path through file_roots without using the Cloudflare files API", async () => {
    installStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/runtime/file_roots")) return json({ jobId: "roots-job" });
      if (url.endsWith("/runtime/file_list")) return json({ jobId: "list-job" });
      if (url.endsWith("/runtime/jobs/roots-job")) return json({ status: "succeeded", result: { workspace: "/owned/workspace" } });
      if (url.endsWith("/runtime/jobs/list-job")) return json({ status: "succeeded", result: { artifacts: [{ path: "/owned/workspace/docs", modifiedAt: "now" }] } });
      throw new Error(`unexpected request ${url}`);
    });

    await api.files("docs", undefined, { scope: "workspace", nodeId: "node-a" });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/nodes/node-a/runtime/file_roots",
      "/api/nodes/node-a/runtime/jobs/roots-job",
      "/api/nodes/node-a/runtime/file_list",
      "/api/nodes/node-a/runtime/jobs/list-job",
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ scope: "computer", path: "/owned/workspace/docs" });
  });

  it("exports through a relay and authenticates content with the relay token", async () => {
    installStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/runtime/file_stat")) return json({ jobId: "stat-job" });
      if (url.endsWith("/runtime/jobs/stat-job")) return json({ status: "succeeded", result: { size: 5, name: "hello.txt", sha256 } });
      if (url === "/api/node-files") return json({ relayId: "relay-1", relayToken: "RELAY", jobId: "export-job" });
      if (url.endsWith("/runtime/jobs/export-job")) return json({ status: "succeeded", result: {} });
      if (url.endsWith("/node-files/relay-1/content")) return new Response(new TextEncoder().encode("hello"), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    });

    const result = await api.fileDownload("/owned/workspace/hello.txt", undefined, { scope: "computer", nodeId: "node-a" });
    expect(await result.text()).toBe("hello");
    const relayCall = calls.find((call) => call.url.endsWith("/node-files/relay-1/content"));
    expect(new Headers(relayCall?.init?.headers).get("authorization")).toBe("Bearer RELAY");
    expect(JSON.parse(String(calls.find((call) => call.url === "/api/node-files")?.init?.body))).toMatchObject({ nodeId: "node-a", direction: "export", sha256 });
  });

  it("keeps computer paths absolute and maps workspace artifacts back to relative paths", async () => {
    installStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/runtime/file_roots")) return json({ jobId: "roots-job" });
      if (url.endsWith("/runtime/jobs/roots-job")) return json({ status: "succeeded", result: { workspace: "/owned/workspace" } });
      if (url.endsWith("/runtime/file_list")) {
        const input = JSON.parse(String(init?.body));
        return input.path === "/" ? json({ jobId: "computer-list" }) : json({ jobId: "workspace-list" });
      }
      if (url.endsWith("/runtime/jobs/computer-list")) return json({ status: "succeeded", result: { artifacts: [{ path: "/tmp/file.txt" }] } });
      if (url.endsWith("/runtime/jobs/workspace-list")) return json({ status: "succeeded", result: { artifacts: [{ path: "/owned/workspace/folder/subname.txt" }] } });
      throw new Error(`unexpected request ${url}`);
    });

    await api.files("/", undefined, { scope: "computer", nodeId: "node-a" });
    const workspace = await api.files("folder", undefined, { scope: "workspace", nodeId: "node-a" });
    const listInputs = calls.filter((call) => call.url.endsWith("/runtime/file_list")).map((call) => JSON.parse(String(call.init?.body)));
    expect(listInputs[0]).toMatchObject({ scope: "computer", path: "/" });
    expect(listInputs[1]).toMatchObject({ scope: "computer", path: "/owned/workspace/folder" });
    expect(workspace).toEqual({ artifacts: [{ path: "folder/subname.txt" }] });
  });

  it("resolves a workspace preview path once before reading it", async () => {
    installStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/runtime/file_roots")) return json({ jobId: "roots-job" });
      if (url.endsWith("/runtime/jobs/roots-job")) return json({ status: "succeeded", result: { workspace: "/owned/workspace" } });
      if (url.endsWith("/runtime/file_read")) return json({ jobId: "read-job" });
      if (url.endsWith("/runtime/jobs/read-job")) return json({ status: "succeeded", result: { contentBase64: btoa("preview") } });
      throw new Error(`unexpected request ${url}`);
    });
    await expect(api.fileContent("folder/subname.txt", undefined, { scope: "workspace", nodeId: "node-a" })).resolves.toBe("preview");
    expect(calls.filter((call) => call.url.endsWith("/runtime/file_roots"))).toHaveLength(1);
    const read = calls.find((call) => call.url.endsWith("/runtime/file_read"));
    expect(JSON.parse(String(read?.init?.body))).toMatchObject({ scope: "computer", path: "/owned/workspace/folder/subname.txt" });
  });

  it("uploads with PUT and waits for the import job to succeed", async () => {
    installStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/node-files") return json({ relayId: "relay-2", relayToken: "RELAY", jobId: "import-job" });
      if (url.endsWith("/node-files/relay-2/content")) return json({ jobId: "import-job" });
      if (url.endsWith("/runtime/jobs/import-job")) return json({ status: "succeeded", result: { path: "/owned/workspace/out.txt" } });
      throw new Error(`unexpected request ${url}`);
    });

    const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    await expect(api.fileUpload("/owned/workspace/out.txt", body, "text/plain", { scope: "computer", nodeId: "node-a", overwrite: true })).resolves.toEqual({ path: "/owned/workspace/out.txt", bytes: 5 });
    const put = calls.find((call) => call.url.endsWith("/node-files/relay-2/content"));
    expect(put?.init?.method).toBe("PUT");
    expect(new Headers(put?.init?.headers).get("authorization")).toBe("Bearer RELAY");
  });

  it("rejects an export whose content digest changed", async () => {
    installStorage();
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/runtime/file_stat")) return json({ jobId: "stat-job" });
      if (url.endsWith("/runtime/jobs/stat-job")) return json({ status: "succeeded", result: { size: 5, sha256 } });
      if (url === "/api/node-files") return json({ relayId: "relay-3", relayToken: "RELAY", jobId: "export-job" });
      if (url.endsWith("/runtime/jobs/export-job")) return json({ status: "succeeded" });
      if (url.endsWith("/node-files/relay-3/content")) return new Response(new TextEncoder().encode("wrong"));
      throw new Error(`unexpected request ${url}`);
    });
    await expect(api.fileDownload("/owned/workspace/hello.txt", undefined, { scope: "computer", nodeId: "node-a" })).rejects.toThrow("file changed");
  });
});
