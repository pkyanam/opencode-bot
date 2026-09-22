import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
// The agent is intentionally a portable .mjs executable rather than a Worker
// package. The runtime tests exercise its exported protocol helpers directly.
// @ts-expect-error no declaration file is needed for the executable seam.
import { availableLoopbackPort, controlBase, executeRunner, register, run, waitForOwnedRunner } from "../scripts/node-agent.mjs";
// @ts-expect-error the runner is a portable JavaScript service under test.
import { RunStore, createServer } from "../runner/server.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("outbound node agent", () => {
  it("normalizes the existing control Worker URL without opening a listener", () => {
    expect(controlBase("https://bot.example/")) .toBe("https://bot.example/api/nodes");
    expect(controlBase("https://bot.example/api/nodes")) .toBe("https://bot.example/api/nodes");
  });

  it("chooses a free loopback port when the configured runner port is occupied", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const selected = await availableLoopbackPort(address.port);
      expect(selected).not.toBe(address.port);
      expect(selected).toBeGreaterThan(0);
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  });

  it("accepts only the owned runner's authenticated health response", async () => {
    let authorization = "";
    const health = createHttpServer((request, response) => {
      authorization = request.headers.authorization?.replace(/^Bearer\s+/i, "") || authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "opencode2-runner", instanceId: "i1" }));
    });
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const address = health.address();
    if (!address || typeof address === "string") throw new Error("health server did not bind");
    const child = new EventEmitter();
    try {
      await waitForOwnedRunner(new URL(`http://127.0.0.1:${address.port}`), "runner-secret", child, 1000);
      expect(authorization).toBe("runner-secret");
    } finally { await new Promise<void>((resolve) => health.close(() => resolve())); }
  });

  it("does not disclose the startup nonce or runner bearer to a wrong-port health responder", async () => {
    let authorization = "";
    let startupHeader = "";
    const health = createHttpServer((request, response) => {
      authorization = request.headers.authorization || "";
      startupHeader = typeof request.headers["x-opencode-startup-nonce"] === "string" ? request.headers["x-opencode-startup-nonce"] : "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "opencode2-runner", instanceId: "wrong", startupNonce: "wrong" }));
    });
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const address = health.address();
    if (!address || typeof address === "string") throw new Error("health server did not bind");
    const child = new EventEmitter();
    try {
      await expect(waitForOwnedRunner(new URL(`http://127.0.0.1:${address.port}`), "runner-secret", child, 100, "expected")).rejects.toThrow("did not pass");
      expect(authorization).toBe("");
      expect(startupHeader).toBe("");
    } finally { await new Promise<void>((resolve) => health.close(() => resolve())); }
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

  it("refuses a cross-node job before contacting the local runner", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeRunner({ id: "job-other-node", payload: { kind: "runner.run", nodeId: "node_b", run: { runId: "run-1", executionNodeId: "node_b", prompt: "hello" } } }, {
      nodeId: "node_a", runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret",
    })).rejects.toThrow("different execution node");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preflights the selected model on the local runner before starting a run", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      if (request.url.endsWith("/catalog")) return Response.json({ models: [] });
      return Response.json({ status: "succeeded", runId: "run-1" });
    }));
    await expect(executeRunner({ id: "job-model", payload: { kind: "runner.run", run: { runId: "run-1", model: "opencode/missing", prompt: "hello" } } }, {
      runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret",
    })).rejects.toThrow("Model opencode/missing is not configured on this computer");
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(["/catalog"]);
  });

  it("carries the target node identity into the local runner request", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      return Response.json(request.url.endsWith("/runs") ? { status: "succeeded", runId: "run-1", final: "ok" } : { status: "succeeded", runId: "run-1" });
    }));
    await executeRunner({ id: "job-a", payload: { kind: "runner.run", nodeId: "node_a", run: { runId: "run-1", executionNodeId: "node_a", prompt: "hello" } } }, {
      nodeId: "node_a", runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret",
    });
    expect(await calls[0].json()).toMatchObject({ executionNodeId: "node_a", runId: "run-1" });
  });

  it("routes allowlisted runtime operations to the authenticated local runner", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      return Response.json({ result: { providers: [] } });
    }));
    const result = await executeRunner({ id: "job-admin", payload: { kind: "runtime.operation", nodeId: "node_a", operation: "providers", input: {} } }, {
      nodeId: "node_a", runnerUrl: "http://127.0.0.1:8787", runnerToken: "secret",
    });
    expect(result).toEqual({ providers: [] });
    expect(calls[0].url).toBe("http://127.0.0.1:8787/runtime/operation");
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret");
    expect(await calls[0].json()).toEqual({ operation: "providers", input: {} });
  });

  it("streams an owner computer file export through the scoped control relay", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      if (calls.length === 1) return new Response("abc", { status: 200, headers: { "content-length": "3", "content-type": "text/plain" } });
      return Response.json({ status: "uploaded" });
    }));
    const result = await executeRunner({ id: "file-export", payload: { kind: "runtime.operation", nodeId: "node_a", operation: "file_export", input: { scope: "computer", path: "/Users/me/note.txt", relayId: "relay_1", relayToken: "relay-secret", size: 3 } } }, {
      nodeId: "node_a", runnerUrl: "http://127.0.0.1:8787", runnerToken: "runner-secret", controlUrl: "https://control.example/api/nodes",
    });
    expect(result).toEqual({ relayId: "relay_1", path: "/Users/me/note.txt", direction: "export", bytes: 3 });
    expect(new URL(calls[0].url).pathname).toBe("/files/content");
    expect(calls[0].headers.get("authorization")).toBe("Bearer runner-secret");
    expect(new URL(calls[1].url).pathname).toBe("/api/node-files/relay_1/content");
    expect(calls[1].headers.get("authorization")).toBe("Bearer relay-secret");
    expect(await calls[1].text()).toBe("abc");
  });

  it("streams a scoped control relay import into the local computer filesystem", async () => {
    const calls: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init); calls.push(request);
      if (calls.length === 1) return new Response("xyz", { status: 200, headers: { "content-length": "3" } });
      return Response.json({ status: "stored" });
    }));
    const result = await executeRunner({ id: "file-import", payload: { kind: "runtime.operation", nodeId: "node_a", operation: "file_import", input: { scope: "computer", path: "/Users/me/incoming.txt", relayId: "relay_2", relayToken: "relay-secret", overwrite: false, size: 3 } } }, {
      nodeId: "node_a", runnerUrl: "http://127.0.0.1:8787", runnerToken: "runner-secret", controlUrl: "https://control.example/api/nodes",
    });
    expect(result).toEqual({ relayId: "relay_2", path: "/Users/me/incoming.txt", direction: "import", bytes: 3 });
    expect(new URL(calls[0].url).pathname).toBe("/api/node-files/relay_2/content");
    expect(calls[0].headers.get("authorization")).toBe("Bearer relay-secret");
    expect(new URL(calls[1].url).pathname).toBe("/files");
    expect(new URL(calls[1].url).searchParams.get("overwrite")).toBe("false");
    expect(calls[1].headers.get("authorization")).toBe("Bearer runner-secret");
    expect(await calls[1].text()).toBe("xyz");
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

  it("runs owned jobs concurrently up to the configured limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "node-agent-parallel-"));
    const configFile = path.join(root, "node.json");
    await writeFile(configFile, JSON.stringify({ controlUrl: "https://control.example/api/nodes", nodeId: "node_a", nodeSecret: "node-secret", runnerUrl: "http://127.0.0.1:8787", runnerToken: "runner-secret", maxParallelJobs: 2 }));
    const jobs = ["job-a", "job-b"].map((id) => ({ id, payload: { kind: "runner.run", run: { runId: id, prompt: id } } }));
    let active = 0;
    let peak = 0;
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/heartbeat")) return Response.json({});
      if (url.pathname.endsWith("/jobs/poll")) return Response.json({ job: jobs[polls++] ?? null });
      if (url.pathname.endsWith("/jobs/") || url.pathname.endsWith("/result")) return Response.json({});
      if (url.pathname.endsWith("/runs")) {
        active += 1; peak = Math.max(peak, active);
        return Response.json({ status: "running", runId: url.pathname.split("/").pop() });
      }
      if (/\/runs\/[^/]+$/.test(url.pathname)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return Response.json({ status: "succeeded", runId: url.pathname.split("/").pop() });
      }
      return Response.json({});
    }));
    try {
      await run({ config: configFile, max_jobs: "2", poll_ms: "1", heartbeat_ms: "5", command_poll_ms: "1" });
      expect(peak).toBe(2);
      expect(active).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
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
