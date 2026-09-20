import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// The agent is intentionally a portable .mjs executable rather than a Worker
// package. The runtime tests exercise its exported protocol helpers directly.
// @ts-expect-error no declaration file is needed for the executable seam.
import { controlBase, executeRunner, register } from "../scripts/node-agent.mjs";
// @ts-expect-error the runner is a portable JavaScript service under test.
import { RunStore, createServer } from "../runner/server.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("outbound node agent", () => {
  it("normalizes the existing control Worker URL without opening a listener", () => {
    expect(controlBase("https://bot.example/")) .toBe("https://bot.example/api/nodes");
    expect(controlBase("https://bot.example/api/nodes")) .toBe("https://bot.example/api/nodes");
  });

  it("registers once and persists the bearer secret in a private config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "node-agent-"));
    try {
      const calls: Request[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return Response.json({ node: { id: "node_1" }, nodeSecret: "ns_secret" }, { status: 201 });
      }));
      await register({ control_url: "https://bot.example", pairing_token: "np_once", name: "Laptop", config: path.join(root, "node.json"), runner_token: "runner-secret" });
      const saved = JSON.parse(await readFile(path.join(root, "node.json"), "utf8"));
      expect(saved).toMatchObject({ nodeId: "node_1", nodeSecret: "ns_secret", runnerToken: "runner-secret" });
      expect(calls[0].url).toBe("https://bot.example/api/nodes/register");
      expect(JSON.parse(await calls[0].text())).toMatchObject({ pairingToken: "np_once", name: "Laptop" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses the runner's existing bearer HTTP protocol for runner jobs", async () => {
    const statuses = [{ status: "running", runId: "run_1" }, { status: "succeeded", runId: "run_1", final: "done" }];
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      if (request.url.endsWith("/runs")) return Response.json(statuses[0], { status: 202 });
      return Response.json(statuses.shift() || { status: "succeeded", runId: "run_1" });
    }));
    const result = await executeRunner({ id: "job_1", payload: { kind: "runner.run", run: { runId: "run_1", prompt: "hello" } } }, { runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret", runnerPollMs: 0 });
    expect(result.status).toBe("succeeded");
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret");
    expect(calls[1].url).toContain("/runs/run_1");
  });

  it("keeps interrupt and approval commands on the same bearer runner protocol", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      return Response.json({ status: request.url.endsWith("/cancel") ? "cancelled" : "running" });
    }));
    await executeRunner({ id: "command-cancel", payload: { kind: "runner.cancel", runId: "run_2" } }, { runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret" });
    await executeRunner({ id: "command-approval", payload: { kind: "runner.approval", runId: "run_2", requestId: "permission_1", decision: "approve" } }, { runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret" });
    expect(calls.map((request) => request.url)).toEqual(["http://127.0.0.1:8787/runs/run_2/cancel", "http://127.0.0.1:8787/runs/run_2/approval"]);
    expect(calls[1].headers.get("authorization")).toBe("Bearer secret");
    expect(await calls[1].json()).toMatchObject({ requestId: "permission_1", decision: "approve" });
  });

  it("executes a node job against the real local runner HTTP server", async () => {
    const runtime = {
      async createSession(input: any) { return input.sessionId || "session_local"; },
      async prompt() {},
      async *events() { yield { type: "session.text.delta", properties: { sessionID: "session_local", delta: "local result" } }; yield { type: "session.execution.succeeded", properties: { sessionID: "session_local" } }; },
    };
    const server = createServer({ store: new RunStore(runtime), authToken: "runner-secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("runner did not bind a TCP port");
      const result = await executeRunner({ id: "job-local", payload: { kind: "runner.run", run: { runId: "run-local", prompt: "hello" } } }, {
        runnerUrl: `http://127.0.0.1:${address.port}`,
        runnerToken: "runner-secret",
        runnerPollMs: 0,
      });
      expect(result).toMatchObject({ status: "succeeded", runId: "run-local", final: "local result" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
