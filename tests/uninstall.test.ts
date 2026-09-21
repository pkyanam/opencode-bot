import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readOwnership, uninstallPlan, uninstallResources } from "../scripts/setup/uninstall.mjs";

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "ocbot-uninstall-"));
  const statePath = resolve(dir, "deployment-state.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, project: "ocbot-personal", accountId: "0123456789abcdef0123456789abcdef", workerName: "ocbot-personal", deploymentUrl: "https://ocbot-personal.workers.dev", resources: { worker: "https://ocbot-personal.workers.dev", workerName: "ocbot-personal", accountId: "0123456789abcdef0123456789abcdef", r2: "ocbot-personal-artifacts", containerApplication: { worker: "ocbot-personal", className: "Sandbox" } } }));
  return { dir, statePath };
}

describe("safe uninstall", () => {
  it("plans without requiring confirmation or invoking a command", async () => {
    const f = fixture();
    const ownership = readOwnership({ statePath: f.statePath, config: { name: "ocbot-personal", bucketName: "ocbot-personal-artifacts" } });
    expect(uninstallPlan(ownership).mutations).toContain("delete installation-owned R2 bucket");
    await expect(uninstallResources({ ownership, root: f.dir, statePath: f.statePath, runner: () => { throw new Error("must not run"); } })).rejects.toThrow(/--yes/);
  });

  it("deletes exact resources, treats 404 as resumed, and records completion", async () => {
    const f = fixture();
    const ownership = readOwnership({ statePath: f.statePath, config: { name: "ocbot-personal", bucketName: "ocbot-personal-artifacts" } });
    const calls: string[][] = [];
    const runner = (_name: string, args: string[]) => {
      calls.push(args);
      if (args.includes("delete") && args.includes("--name")) return { status: 1, stdout: "", stderr: "404 not found" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    const apiCalls: string[] = [];
    const apiRequest = async (path: string, query?: Record<string, string>, method = "GET") => { apiCalls.push(`${method} ${path}`); if(path.endsWith("/settings")) return {result:{bindings:[{type:"durable_object_namespace",name:"SANDBOX",namespace_id:"ns"}]}}; if(path.endsWith("/applications")) return {result:[{id:"11111111-1111-1111-1111-111111111111",name:"ocbot-personal-sandbox",durable_objects:{namespace_id:"ns"}},{id:"22222222-2222-2222-2222-222222222222",name:"unrelated",durable_objects:{namespace_id:"other"}}]}; return method === "GET" ? { result: { objects: [{ key: "a/file.txt" }, { key: "b.txt" }] }, result_info: {} } : { result: {} }; };
    await uninstallResources({ ownership, root: f.dir, statePath: f.statePath, yes: true, runner, apiRequest, log: () => {} });
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    const saved = JSON.parse(readFileSync(f.statePath, "utf8"));
    expect(saved.uninstalledAt).toBeTruthy();
    expect(apiCalls).toContain("DELETE /accounts/0123456789abcdef0123456789abcdef/containers/applications/11111111-1111-1111-1111-111111111111");
    expect(apiCalls.some(call=>call.startsWith("DELETE") && call.includes("22222222"))).toBe(false);
    expect(calls.some((args) => args.includes("--name") && args.includes("ocbot-personal"))).toBe(true);
    expect(apiCalls.some((call) => call.includes("a%2Ffile.txt"))).toBe(true);
  });

  it("rejects a mismatched Worker URL", () => {
    const f = fixture();
    const state = JSON.parse(readFileSync(f.statePath, "utf8"));
    state.deploymentUrl = "https://someone-else.workers.dev";
    writeFileSync(f.statePath, JSON.stringify(state));
    expect(() => readOwnership({ statePath: f.statePath, config: { name: "ocbot-personal" } })).toThrow(/refusing to delete/);
  });
});
