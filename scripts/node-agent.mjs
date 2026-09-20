#!/usr/bin/env node
import { randomBytes } from "node:crypto";

/** Outbound user-owned node agent. It never listens on a network port. */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const VERSION = "0.1.0";
const DEFAULT_POLL_MS = 3000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) { result._.push(item); continue; }
    const key = item.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    result[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return result;
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/node-agent.mjs register --control-url URL --pairing-token TOKEN --name NAME
  node scripts/node-agent.mjs run [--config FILE] [--once]
  node scripts/node-agent.mjs start [--config FILE]  (also start the loopback runner)

Environment overrides: NODE_CONTROL_URL, NODE_RUNNER_URL, NODE_RUNNER_TOKEN,
NODE_CONFIG, NODE_POLL_MS, NODE_HEARTBEAT_MS.
`);
}

function defaultConfigPath() {
  if (process.env.NODE_CONFIG) return process.env.NODE_CONFIG;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode-bot", "node.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "opencode-bot", "node.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode-bot", "node.json");
}

function platform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function controlBase(value) {
  const url = new URL(value);
  const current = url.pathname.replace(/^\/+|\/+$/g, "");
  url.pathname = current.endsWith("api/nodes") ? `/${current}` : current === "api" ? "/api/nodes" : `/${current ? `${current}/` : ""}api/nodes`;
  return url.toString().replace(/\/$/, "");
}

async function loadConfig(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

async function saveConfig(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function jsonFetch(url, { token, method = "GET", body } = {}) {
  const headers = { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value = null;
  try { value = await response.json(); } catch { /* response body is optional */ }
  if (!response.ok) throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${value?.error || "request failed"}`);
  return value;
}

function capabilities(runner = Boolean(process.env.NODE_RUNNER_TOKEN)) {
  return { os: platform(), arch: process.arch, runner, desktop: false, browser: false, maxParallelJobs: 1 };
}

async function liveCapabilities(config) {
  try {
    const url = new URL(config.runnerUrl || 'http://127.0.0.1:8787');
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return capabilities(false);
    const response = await fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(2000) });
    return capabilities(Boolean(config.runnerToken) && response.ok);
  } catch { return capabilities(false); }
}

async function register(options) {
  if (!options.control_url || !options.pairing_token || !options.name) throw new Error("--control-url, --pairing-token, and --name are required");
  const file = options.config || process.env.NODE_CONFIG || defaultConfigPath();
  const base = controlBase(options.control_url);
  const result = await jsonFetch(`${base}/register`, { method: "POST", body: {
    pairingToken: options.pairing_token, name: options.name, platform: platform(), arch: process.arch,
    agentVersion: VERSION, capabilities: capabilities(Boolean(options.runner_token || process.env.NODE_RUNNER_TOKEN)),
  } });
  await saveConfig(file, { controlUrl: base, nodeId: result.node.id, nodeSecret: result.nodeSecret,
    runnerUrl: options.runner_url || process.env.NODE_RUNNER_URL || "http://127.0.0.1:8787",
    runnerToken: options.runner_token || process.env.NODE_RUNNER_TOKEN || randomBytes(32).toString("hex") });
  process.stdout.write(`${JSON.stringify({ node: result.node, config: file })}\n`);
  return result;
}

function terminalStatus(status) { return ["succeeded", "failed", "cancelled", "needs_review"].includes(status); }

async function executeRunner(job, config, onProgress) {
  const payload = job.payload || {};
  if (payload.kind === "runner.cancel" || payload.kind === "runner.approval") {
    if (!config.runnerToken) throw new Error("NODE_RUNNER_TOKEN is required for runner commands");
    const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(runner).hostname)) throw new Error("Local runner URL must use loopback");
    const runId = String(payload.runId || payload.run?.runId || "");
    if (!runId) throw new Error("runner command is missing runId");
    const suffix = payload.kind === "runner.cancel" ? "cancel" : "approval";
    const body = payload.kind === "runner.approval" ? { requestId: payload.requestId, decision: payload.decision } : undefined;
    const result = await jsonFetch(`${runner}/runs/${encodeURIComponent(runId)}/${suffix}`, { method: "POST", token: config.runnerToken, ...(body ? { body } : {}) });
    return { status: result.status || (payload.kind === "runner.cancel" ? "cancelled" : "running"), ...result };
  }
  if (payload.kind !== "runner.run") throw new Error(`unsupported job kind: ${String(payload.kind || "missing")}`);
  if (!payload.run || typeof payload.run !== "object") throw new Error("runner.run payload is missing run input");
  if (!config.runnerToken) throw new Error("NODE_RUNNER_TOKEN is required for runner.run jobs");
  const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(runner).hostname)) throw new Error("Local runner URL must use loopback");
  const input = payload.run;
  const started = await jsonFetch(`${runner}/runs`, { method: "POST", token: config.runnerToken, body: input });
  let current = started;
  const runnerRunId = String(input.runId || started.runId || job.id);
  const deadline = Date.now() + Number(config.jobTimeoutMs || 24 * 60 * 60_000);
  while (!terminalStatus(current.status)) {
    if (Date.now() > deadline) throw new Error("runner job timed out");
    await new Promise((resolve) => setTimeout(resolve, Number(config.runnerPollMs || 1000)));
    current = await jsonFetch(`${runner}/runs/${encodeURIComponent(runnerRunId)}`, { token: config.runnerToken });
    if (onProgress) await onProgress(current).catch(() => undefined);
  }
  if (current.status !== "succeeded") throw new Error(`runner returned ${String(current.status)}`);
  return current;
}

async function run(options) {
  const file = options.config || process.env.NODE_CONFIG || defaultConfigPath();
  const config = await loadConfig(file);
  const base = controlBase(options.control_url || config.controlUrl || process.env.NODE_CONTROL_URL || "");
  if (!config.nodeId || !config.nodeSecret) throw new Error(`node is not registered; run the register command first (config: ${file})`);
  let localRunner;
  if (options.start_runner || options.start || options._?.[0] === "start") {
    if (!config.runnerToken) throw new Error("runner token is required when starting the local runner");
    const entrypoint = process.env.NODE_RUNNER_ENTRYPOINT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../runner/server.mjs");
    await mkdir(path.join(path.dirname(file), "state"), { recursive: true });
    await mkdir(path.join(path.dirname(file), "workspace"), { recursive: true });
    localRunner = spawn(process.execPath, [entrypoint], { cwd: path.dirname(entrypoint), env: { ...process.env, RUNTIME_ROOT: path.join(path.dirname(file), "state"), WORKSPACE_DIRECTORY: path.join(path.dirname(file), "workspace"), RUNNER_HOST: "127.0.0.1", RUNNER_TOKEN: config.runnerToken, RUNNER_PORT: new URL(config.runnerUrl || "http://127.0.0.1:8787").port || "8787" }, stdio: "inherit", windowsHide: false });
    process.once("SIGINT", () => localRunner.kill("SIGINT"));
    process.once("SIGTERM", () => localRunner.kill("SIGTERM"));
  }
  let lastHeartbeat = 0;
  let count = 0;
  do {
    const now = Date.now();
    let response;
    try {
      if (now - lastHeartbeat >= Number(options.heartbeat_ms || process.env.NODE_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS)) {
        await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/heartbeat`, { method: "POST", token: config.nodeSecret, body: { agentVersion: VERSION, capabilities: await liveCapabilities(config) } });
        lastHeartbeat = now;
      }
      response = await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/poll`, { token: config.nodeSecret });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (401|403|404)\b/.test(message)) throw error;
      process.stderr.write(`node-agent: control Worker unavailable; retrying (${message})\n`);
      await sleep(Math.min(30_000, Number(options.poll_ms || process.env.NODE_POLL_MS || DEFAULT_POLL_MS) * 2));
      continue;
    }
    if (response.job) {
      const job = response.job;
      let commandBusy = false;
      const keepAlive = setInterval(async () => {
        jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/heartbeat`, { method: "POST", token: config.nodeSecret, body: { agentVersion: VERSION, capabilities: await liveCapabilities(config) } }).catch(() => undefined);
      }, Number(options.heartbeat_ms || process.env.NODE_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS));
      const commandPoll = setInterval(async () => {
        if (commandBusy) return;
        try {
          const commandResponse = await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/poll`, { token: config.nodeSecret });
          if (!commandResponse.job || commandResponse.job.id === job.id) return;
          commandBusy = true;
          try {
            const result = await executeRunner(commandResponse.job, config);
            await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(commandResponse.job.id)}/result`, { method: "POST", token: config.nodeSecret, body: { ok: true, result } });
          } catch (error) {
            await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(commandResponse.job.id)}/result`, { method: "POST", token: config.nodeSecret, body: { ok: false, error: error instanceof Error ? error.message : String(error) } });
          } finally { commandBusy = false; }
        } catch { /* main run remains authoritative if command polling is interrupted */ }
      }, Number(options.command_poll_ms || 1000));
      try {
        const result = await executeRunner(job, config, async (progress) => {
          await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(job.id)}/progress`, { method: "POST", token: config.nodeSecret, body: { result: progress } });
        });
        await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(job.id)}/result`, { method: "POST", token: config.nodeSecret, body: { ok: true, result } });
      } catch (error) {
        await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(job.id)}/result`, { method: "POST", token: config.nodeSecret, body: { ok: false, error: error instanceof Error ? error.message : String(error) } });
      } finally { clearInterval(keepAlive); clearInterval(commandPoll); }
    } else if (options.once) break;
    count += 1;
    if (options.once || Number(options.max_jobs || 0) > 0 && count >= Number(options.max_jobs)) break;
    await sleep(Number(options.poll_ms || process.env.NODE_POLL_MS || DEFAULT_POLL_MS));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = args(process.argv.slice(2));
  try {
    if (options.help || options.h) { usage(); process.exitCode = 0; }
    else {
    const command = options._[0] || "run";
    if (command === "register") await register(options);
    else if (command === "run" || command === "start") await run(options);
    else { usage(); process.exitCode = 2; }
    }
  } catch (error) {
    process.stderr.write(`node-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { capabilities, controlBase, executeRunner, register, run };
