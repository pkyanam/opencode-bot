#!/usr/bin/env node
/**
 * Offline OpenCode 2 qualification harness.
 *
 * It starts the installed (or OPENCODE2_BIN-selected) v2 CLI in an isolated
 * HOME/XDG tree and points an OpenAI-compatible provider at a local fake model.
 * No user config, credentials, model provider, or background OpenCode service
 * is touched. Run with `node tests/qualification/opencode2.mjs`.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { OpenCode2Runtime } from "../../packages/runtime-opencode2/src/client.mjs";
import { RunStore, createServer as createRunnerServer } from "../../runner/server.mjs";

const cli = process.env.OPENCODE2_BIN || "opencode2";
const expectedVersion = process.env.OPENCODE2_VERSION || "2.0.11";
let cliVersion;
try {
  cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
} catch (error) {
  throw new Error(`Unable to execute ${cli}: ${error.message}`);
}
if (!cliVersion.endsWith(`v${expectedVersion}`)) {
  throw new Error(`Pinned OpenCode 2 qualification requires ${expectedVersion}; ${cli} reported ${cliVersion}. Set OPENCODE2_BIN to the pinned CLI binary.`);
}
const root = await mkdtemp(path.join(os.tmpdir(), "opencode2-qualification-"));
const configHome = path.join(root, "config");
const dataHome = path.join(root, "data");
const stateHome = path.join(root, "state");
const workspace = path.join(root, "workspace");
await Promise.all([mkdir(path.join(configHome, "opencode"), { recursive: true }), mkdir(workspace, { recursive: true })]);

let modelCalls = 0;
const model = createServer(async (req, res) => {
  if (req.url === "/v1/models" || req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "qualification" }] }));
    return;
  }
  if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
    res.writeHead(404); res.end(); return;
  }
  modelCalls++;
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  const userText = [...(input.messages || [])].reverse().find((entry) => entry.role === "user")?.content || "";
  const text = String(userText).includes("continuation") ? "continuation-ok" : "qualification-ok";
  res.setHeader("content-type", input.stream ? "text/event-stream" : "application/json");
  res.setHeader("cache-control", "no-cache");
  if (!input.stream) {
    res.end(JSON.stringify({ id: `fake-${modelCalls}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
  res.write(event({ id: `fake-${modelCalls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
  res.write(event({ id: `fake-${modelCalls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
const config = {
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "qualification": {
      "name": "Qualification fake model",
      "package": "@opencode/ai/providers/openai-compatible",
      "env": ["QUALIFICATION_KEY"],
      "settings": { "baseURL": modelUrl },
      "models": { "fake-model": { "name": "Qualification fake model" } }
    }
  },
  "permissions": { "edit": "deny", "shell": "deny", "webfetch": "deny" }
};
await writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify(config, null, 2));

const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: dataHome,
  XDG_STATE_HOME: stateHome,
  QUALIFICATION_KEY: "offline-test-key",
  OPENCODE_DIRECTORY: workspace,
};
let server;
let stderr = "";
const cleanup = async () => {
  if (server && !server.killed) server.kill("SIGTERM");
  if (server) await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  model.close();
  await rm(root, { recursive: true, force: true });
};
process.once("SIGINT", async () => { await cleanup(); process.exit(130); });
process.once("SIGTERM", async () => { await cleanup(); process.exit(143); });

try {
  const port = await findPort();
  const runtime = new OpenCode2Runtime({
    root,
    directory: workspace,
    command: [cli, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port)],
    env,
  });
  const info = await (await runtime.start()).server.info();
  assert.match(String(info.version || ""), /^2\./, `expected v2 server, got ${JSON.stringify(info)}`);
  const runner = createRunnerServer({ store: new RunStore(runtime), authToken: "qualification-runner", workspace });
  await new Promise((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const runnerBase = `http://127.0.0.1:${runner.address().port}`;
  const unauthorized = await fetch(`${runnerBase}/runs`, { method: "POST", body: JSON.stringify({ runId: "unauthorized", prompt: "must reject" }) });
  assert.equal(unauthorized.status, 401);
  const artifactUpload = await fetch(`${runnerBase}/files?path=qualification.txt`, { method: "POST", headers: { authorization: "Bearer qualification-runner", "content-type": "application/octet-stream" }, body: "artifact-ok" });
  assert.equal(artifactUpload.status, 201);
  const artifactDownload = await fetch(`${runnerBase}/files/content?path=qualification.txt`, { headers: { authorization: "Bearer qualification-runner" } });
  assert.equal(artifactDownload.status, 200);
  assert.equal(await artifactDownload.text(), "artifact-ok");
  const first = await admitRun(runnerBase, { runId: "qualification-1", prompt: "say the qualification marker", model: "qualification/fake-model", directory: workspace });
  const firstDone = await waitForRun(runnerBase, first.runId);
  assert.equal(firstDone.status, "succeeded", JSON.stringify(firstDone));
  assert.match(firstDone.final, /qualification-ok/);
  const second = await admitRun(runnerBase, { runId: "qualification-2", sessionId: firstDone.sessionId, prompt: "this is a continuation", model: "qualification/fake-model", directory: workspace });
  const secondDone = await waitForRun(runnerBase, second.runId);
  assert.equal(secondDone.status, "succeeded", JSON.stringify(secondDone));
  assert.match(secondDone.final, /continuation-ok/);
  assert.equal(secondDone.sessionId, firstDone.sessionId);
  assert.ok(modelCalls >= 2, `fake model should receive two calls, received ${modelCalls}`);
  console.log(JSON.stringify({ ok: true, serverVersion: info.version, sessionID: firstDone.sessionId, modelCalls, runner: "RunStore/createServer" }, null, 2));
  await new Promise((resolve) => runner.close(resolve));
  await runtime.stop();
} catch (error) {
  console.error(`OpenCode 2 qualification failed: ${error.message}\n${stderr}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function findPort() {
  const net = await import("node:net");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, process, getStderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`serve exited: ${getStderr()}`);
    try {
      const response = await fetch(`${baseUrl}/global/health`);
      if ((response.ok || response.status === 401 || response.status === 404) && await fileExists(path.join(stateHome, "opencode", "service.json"))) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for OpenCode serve");
}

async function fileExists(file) {
  try { await readFile(file); return true; } catch { return false; }
}

async function admitRun(base, input) {
  const response = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: "Bearer qualification-runner", "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(response.status, 202);
  return response.json();
}

async function waitForRun(base, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/runs/${runId}`, { headers: { authorization: "Bearer qualification-runner" } });
    const run = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}
