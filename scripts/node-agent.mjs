#!/usr/bin/env node
import { randomBytes } from "node:crypto";

/** Outbound user-owned node agent. It never listens on a network port. */
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { checkLocalModelReadiness } from "./node-model-readiness.mjs";
import { transferFile } from "./node-transfer.mjs";

const VERSION = "0.1.0";
let installedVersion;
async function agentVersion() {
  if (installedVersion !== undefined) return installedVersion;
  try {
    const metadata = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bundle-version.json"), "utf8"));
    installedVersion = /^v\d+\.\d+\.\d+$/.test(metadata.version) ? metadata.version : VERSION;
  } catch { installedVersion = VERSION; }
  return installedVersion;
}
const DEFAULT_POLL_MS = 3000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_NODE_FILE_RELAY_BYTES = 50 * 1024 * 1024;
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
  await chmod(path.dirname(file), 0o700);
  await chmod(file, 0o600);
}

async function updateLocked(configFile) {
  try { await stat(path.join(path.dirname(configFile), "update.lock")); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function availableLoopbackPort(preferred = 8787) {
  const candidate = Number(preferred);
  const tryPort = (port) => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port }, () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  try { return await tryPort(Number.isInteger(candidate) && candidate > 0 && candidate < 65536 ? candidate : 0); }
  catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    return tryPort(0);
  }
}

async function waitForOwnedRunner(url, token, child, timeoutMs = 15_000, startupNonce) {
  const deadline = Date.now() + timeoutMs;
  let childError;
  const onError = (error) => { childError = error; };
  const onExit = (code, signal) => { childError = new Error(`local runner exited before health check (code ${code ?? "unknown"}, signal ${signal ?? "none"})`); };
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    while (Date.now() < deadline) {
      if (childError) throw childError;
      try {
        const response = await fetch(`${url.origin}/health`, { headers: { accept: "application/json", ...(startupNonce ? {} : { authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(1000) });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.ok === true && body?.service === "opencode2-runner" && typeof body.instanceId === "string" && body.instanceId) {
          if (!startupNonce) return;
          if (body.startupNonce !== startupNonce) continue;
          if (childError || (child.exitCode !== undefined && child.exitCode !== null)) throw childError ?? new Error("local runner exited before authenticated health check");
          const state = await fetch(`${url.origin}/checkpoint/state`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(1000) });
          const stateBody = await state.json().catch(() => null);
          if (state.ok && stateBody?.instanceId === body.instanceId) return;
        }
      } catch { /* runner is still starting or the port is not ours */ }
      await sleep(100);
    }
    throw new Error("local runner did not pass its authenticated health check");
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

async function jsonFetch(url, { token, method = "GET", body } = {}) {
  const headers = { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const timeoutMs = Math.max(1000, Number(process.env.NODE_HTTP_TIMEOUT_MS || 30_000));
  const response = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value = null;
  try { value = await response.json(); } catch { /* response body is optional */ }
  if (!response.ok) throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${value?.error || "request failed"}`);
  return value;
}

function computerPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) throw new Error("computer file path must be absolute");
  return path.normalize(value);
}

function relayUrl(controlUrl, relayId) {
  if (typeof relayId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(relayId)) throw new Error("relayId is invalid");
  const control = new URL(controlUrl);
  return new URL(`/api/node-files/${encodeURIComponent(relayId)}/content`, control.origin).toString();
}

async function relayComputerFile({ direction, runner, runnerToken, controlUrl, relayId, relayToken, filePath, overwrite = false, size }) {
  if (typeof relayToken !== "string" || !relayToken) throw new Error("relayToken is required");
  const target = computerPath(filePath);
  const relay = relayUrl(controlUrl, relayId);
  const headers = { authorization: `Bearer ${relayToken}`, accept: "application/octet-stream" };
  if (direction === "export") {
    const local = await fetch(`${runner}/files/content?scope=computer&path=${encodeURIComponent(target)}`, { headers: { authorization: `Bearer ${runnerToken}`, accept: "application/octet-stream" }, signal: AbortSignal.timeout(120_000) });
    if (!local.ok || !local.body) throw new Error(`local computer file export failed (${local.status})`);
    const declared = Number(local.headers.get("content-length") || size || 0);
    if (declared > MAX_NODE_FILE_RELAY_BYTES) throw new Error("computer file exceeds relay limit");
    let bytes = 0;
    const bounded = local.body.pipeThrough(new TransformStream({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > MAX_NODE_FILE_RELAY_BYTES) { controller.error(new Error("computer file exceeds relay limit")); return; } controller.enqueue(chunk); } }));
    const uploaded = await fetch(relay, { method: "PUT", headers: { ...headers, "content-type": local.headers.get("content-type") || "application/octet-stream", ...(declared ? { "content-length": String(declared) } : {}) }, body: bounded, duplex: "half", signal: AbortSignal.timeout(120_000) });
    if (!uploaded.ok) throw new Error(`computer file relay upload failed (${uploaded.status})`);
    return { relayId, path: target, direction, bytes: bytes || declared };
  }
  const downloaded = await fetch(relay, { headers, signal: AbortSignal.timeout(120_000) });
  if (!downloaded.ok || !downloaded.body) throw new Error(`computer file relay download failed (${downloaded.status})`);
  const declared = Number(downloaded.headers.get("content-length") || size || 0);
  if (declared > MAX_NODE_FILE_RELAY_BYTES) throw new Error("computer file exceeds relay limit");
  const local = await fetch(`${runner}/files?scope=computer&path=${encodeURIComponent(target)}&overwrite=${overwrite ? "true" : "false"}`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": downloaded.headers.get("content-type") || "application/octet-stream", ...(declared ? { "content-length": String(declared) } : {}) }, body: downloaded.body, duplex: "half", signal: AbortSignal.timeout(120_000) });
  if (!local.ok) throw new Error(`local computer file import failed (${local.status})`);
  return { relayId, path: target, direction, bytes: declared || undefined };
}

function capabilities(runner = Boolean(process.env.NODE_RUNNER_TOKEN), browser = Boolean(process.env.OPENCODE_BOT_BROWSER), maxParallelJobs = 4) {
  return { os: platform(), arch: process.arch, runner, desktop: false, browser, maxParallelJobs: Math.max(1, Math.min(4, Number(maxParallelJobs) || 4)) };
}

async function liveCapabilities(config) {
  try {
    const url = new URL(config.runnerUrl || 'http://127.0.0.1:8787');
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return capabilities(false, false, config.maxParallelJobs);
    const response = await fetch(`${url.origin}/health`, { headers: { accept: "application/json", ...(config.runnerStartupNonce ? {} : config.runnerToken ? { authorization: `Bearer ${config.runnerToken}` } : {}) }, signal: AbortSignal.timeout(2000) });
    const body = await response.json().catch(() => null);
    let runnerReady = Boolean(config.runnerToken) && response.ok && body?.ok === true && body?.service === "opencode2-runner" && typeof body.instanceId === "string" && body.instanceId.length > 0;
    if (runnerReady && config.runnerStartupNonce) {
      runnerReady = body.startupNonce === config.runnerStartupNonce;
    }
    if (runnerReady && config.runnerStartupNonce) {
      const state = await fetch(`${url.origin}/checkpoint/state`, { headers: { authorization: `Bearer ${config.runnerToken}`, accept: "application/json" }, signal: AbortSignal.timeout(2000) });
      const stateBody = await state.json().catch(() => null);
      runnerReady = state.ok && stateBody?.instanceId === body.instanceId;
    }
    return capabilities(runnerReady, runnerReady && Boolean(config.browser), config.maxParallelJobs);
  } catch { return capabilities(false, false, config.maxParallelJobs); }
}

async function register(options) {
  if (!options.control_url || !options.pairing_token || !options.name) throw new Error("--control-url, --pairing-token, and --name are required");
  const file = options.config || process.env.NODE_CONFIG || defaultConfigPath();
  const base = controlBase(options.control_url);
  const result = await jsonFetch(`${base}/register`, { method: "POST", body: {
    pairingToken: options.pairing_token, name: options.name, platform: platform(), arch: process.arch,
    agentVersion: await agentVersion(), capabilities: capabilities(Boolean(options.runner_token || process.env.NODE_RUNNER_TOKEN)),
  } });
  await saveConfig(file, { controlUrl: base, nodeId: result.node.id, nodeSecret: result.nodeSecret,
    runnerUrl: options.runner_url || process.env.NODE_RUNNER_URL || "http://127.0.0.1:8787",
    runnerToken: options.runner_token || process.env.NODE_RUNNER_TOKEN || randomBytes(32).toString("hex"),
    workspaceDirectory: path.join(path.dirname(file), "workspace") });
  process.stdout.write(`${JSON.stringify({ node: result.node, config: file })}\n`);
  return result;
}

function terminalStatus(status) { return ["succeeded", "failed", "cancelled", "needs_review"].includes(status); }

async function executeRunner(job, config, onProgress) {
  if (await updateLocked(config._file || process.env.NODE_CONFIG || defaultConfigPath())) throw new Error("node update is in progress; job was not admitted");
  const payload = job.payload || {};
  if (payload.nodeId && String(payload.nodeId) !== String(config.nodeId)) throw new Error("node job is bound to a different execution node");
  if (payload.run?.executionNodeId && String(payload.run.executionNodeId) !== String(config.nodeId)) throw new Error("runner run is bound to a different execution node");
  if (payload.kind === "node.transfer") {
    const manifest = payload.transfer ?? payload.manifest;
    const transferToken = payload.transferToken ?? payload.token;
    if (!manifest || typeof manifest !== "object") throw new Error("node.transfer payload is missing manifest");
    if (payload.direction !== "upload" && payload.direction !== "download") throw new Error("transfer direction is required");
    const direction = payload.direction;
    const expectedNode = direction === "upload" ? manifest.sourceNodeId : manifest.targetNodeId;
    if (expectedNode !== config.nodeId) throw new Error("transfer is bound to a different node");
    if (typeof transferToken !== "string" || !transferToken) throw new Error("node.transfer payload is missing scoped token");
    const controlRoot = String(config.controlUrl || "").replace(/\/api\/nodes\/?$/, "");
    if (!controlRoot) throw new Error("node transfer control URL is missing");
    const workspace = config.workspaceDirectory;
    if (!workspace) throw new Error("node transfer workspace is missing");
    return transferFile({ direction, baseUrl: controlRoot, token: transferToken, manifest, sourceRoot: workspace, destinationRoot: workspace, overwrite: payload.overwrite === true });
  }
  if (payload.kind === "runtime.operation") {
    const allowed = new Set(["catalog", "providers", "providers/key", "providers/custom", "providers/credentials/activate", "providers/credentials/label", "providers/credentials/remove", "providers/oauth/start", "providers/oauth/status", "providers/oauth/complete", "providers/oauth/cancel", "providers/command/start", "providers/command/status", "providers/command/cancel", "mcps", "mcps/add", "mcps/remove", "mcps/connect", "mcps/disconnect", "mcps/oauth/start", "mcps/oauth/status", "mcps/oauth/complete", "mcps/oauth/cancel", "generate/text", "file_roots", "file_list", "file_read", "file_stat", "file_mkdir", "file_move", "file_delete", "file_export", "file_import"]);
    if (typeof payload.operation !== "string" || !allowed.has(payload.operation)) throw new Error("unsupported node runtime operation");
    if (!config.runnerToken) throw new Error("NODE_RUNNER_TOKEN is required for runtime operations");
    const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(runner).hostname)) throw new Error("Local runner URL must use loopback");
    if (payload.operation === "file_export" || payload.operation === "file_import") {
      const input = payload.input && typeof payload.input === "object" ? payload.input : {};
      if (input.scope !== "computer") throw new Error("computer file relay requires scope=computer");
      return relayComputerFile({ direction: payload.operation === "file_export" ? "export" : "import", runner, runnerToken: config.runnerToken, controlUrl: config.controlUrl, relayId: input.relayId, relayToken: input.relayToken, filePath: input.path, overwrite: input.overwrite === true, size: input.size });
    }
    const result = await jsonFetch(`${runner}/runtime/operation`, { method: "POST", token: config.runnerToken, body: { operation: payload.operation, input: payload.input && typeof payload.input === "object" ? payload.input : {} } });
    return result.result;
  }
  if (payload.kind === "runner.bot-receipts") {
    if (!config.runnerToken) throw new Error("NODE_RUNNER_TOKEN is required for bot receipt commands");
    const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(runner).hostname)) throw new Error("Local runner URL must use loopback");
    const runId = String(payload.runId || payload.run?.runId || "");
    if (!runId) throw new Error("bot receipt command is missing runId");
    if (!payload.receipts || typeof payload.receipts !== "object" || Array.isArray(payload.receipts)) throw new Error("bot receipt command is missing receipts");
    return await jsonFetch(`${runner}/runs/${encodeURIComponent(runId)}/bot-receipts`, { method: "POST", token: config.runnerToken, body: payload.receipts });
  }
  if (payload.kind === "runner.questions" || payload.kind === "runner.question.reply" || payload.kind === "runner.question.reject") {
    if (!config.runnerToken) throw new Error("NODE_RUNNER_TOKEN is required for runner question commands");
    const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(runner).hostname)) throw new Error("Local runner URL must use loopback");
    const runId = String(payload.runId || payload.run?.runId || "");
    if (!runId) throw new Error("runner question command is missing runId");
    if (payload.kind === "runner.questions") {
      const result = await jsonFetch(`${runner}/runs/${encodeURIComponent(runId)}/questions`, { method: "GET", token: config.runnerToken });
      return { questions: Array.isArray(result.questions) ? result.questions : [] };
    }
    const requestId = String(payload.requestId || "");
    if (!requestId) throw new Error("runner question command is missing requestId");
    const suffix = payload.kind === "runner.question.reply" ? "reply" : "reject";
    const body = suffix === "reply" ? { answers: payload.answers } : {};
    const result = await jsonFetch(`${runner}/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(requestId)}/${suffix}`, { method: "POST", token: config.runnerToken, body });
    return result && typeof result === "object" ? result : { accepted: true };
  }
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
  await checkLocalModelReadiness({ runnerUrl: runner, runnerToken: config.runnerToken, model: payload.run.model });
  const input = { ...payload.run, directory: config.workspaceDirectory || payload.run.directory };
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
  let config = await loadConfig(file);
  config = { ...config, _file: file };
  const base = controlBase(options.control_url || config.controlUrl || process.env.NODE_CONTROL_URL || "");
  if (!config.nodeId || !config.nodeSecret) throw new Error(`node is not registered; run the register command first (config: ${file})`);
  let localRunner;
  let localRunnerError;
  if (options.start_runner || options.start || options._?.[0] === "start") {
    if (!config.runnerToken) throw new Error("runner token is required when starting the local runner");
    const entrypoint = process.env.NODE_RUNNER_ENTRYPOINT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../runner/server.mjs");
    await mkdir(path.join(path.dirname(file), "state"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(path.dirname(file), "workspace"), { recursive: true, mode: 0o700 });
    const runnerBin = path.join(path.dirname(entrypoint), "node_modules", ".bin");
    const configuredUrl = new URL(config.runnerUrl || "http://127.0.0.1:8787");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(configuredUrl.hostname)) throw new Error("Local runner URL must use loopback");
    const runnerPort = await availableLoopbackPort(configuredUrl.port || 8787);
    const runnerUrl = new URL(configuredUrl);
    runnerUrl.hostname = "127.0.0.1";
    runnerUrl.port = String(runnerPort);
    const browserRoot = path.resolve(path.dirname(entrypoint), "../../browsers");
    const browserConfig = path.join(path.dirname(file), "browser");
    const startupNonce = randomBytes(32).toString("hex");
    config = { ...config, runnerUrl: runnerUrl.origin, browser: true, workspaceDirectory: path.join(path.dirname(file), "workspace"), runnerStartupNonce: startupNonce };
    const { runnerStartupNonce: _startupNonce, _file: _configFile, ...persistedConfig } = config;
    await saveConfig(file, persistedConfig);
    await mkdir(browserConfig, { recursive: true, mode: 0o700 });
    await mkdir(path.join(browserConfig, "profile"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(browserConfig, "output"), { recursive: true, mode: 0o700 });
    localRunner = spawn(process.execPath, [entrypoint], { cwd: path.dirname(entrypoint), env: { ...process.env, PATH: [runnerBin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter), OPENCODE_BOT_DESKTOP: process.env.OPENCODE_BOT_DESKTOP ?? "0", OPENCODE_BOT_BROWSER: "1", PLAYWRIGHT_BROWSERS_PATH: browserRoot, PLAYWRIGHT_MCP_JS: path.join(path.dirname(entrypoint), "node_modules", "@playwright", "mcp", "cli.js"), PLAYWRIGHT_PROFILE_DIR: path.join(browserConfig, "profile"), PLAYWRIGHT_OUTPUT_DIR: path.join(browserConfig, "output"), PLAYWRIGHT_NO_SANDBOX: "0", NODE_RUNNER_STARTUP_NONCE: startupNonce, RUNTIME_ROOT: path.join(path.dirname(file), "state"), WORKSPACE_DIRECTORY: path.join(path.dirname(file), "workspace"), RUNNER_HOST: "127.0.0.1", RUNNER_TOKEN: config.runnerToken, RUNNER_PORT: String(runnerPort) }, stdio: "inherit", windowsHide: false });
    localRunner.once("error", (error) => { localRunnerError = error; });
    localRunner.once("exit", (code, signal) => { localRunnerError = new Error(`local runner exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`); });
    const stopRunner = () => { if (localRunner && localRunner.exitCode === null) localRunner.kill("SIGINT"); };
    process.once("SIGINT", stopRunner);
    process.once("SIGTERM", stopRunner);
    try { await waitForOwnedRunner(runnerUrl, config.runnerToken, localRunner, 15_000, startupNonce); }
    catch (error) { stopRunner(); throw error; }
  }
  // The local runner's scheduler has four execution lanes; keep the node
  // admission limit aligned with it even when a stale config asks for more.
  const maxParallelJobs = Math.max(1, Math.min(4, Number(options.max_parallel_jobs || config.maxParallelJobs || 4) || 4));
  config = { ...config, maxParallelJobs };
  const pollMs = Number(options.poll_ms || process.env.NODE_POLL_MS || DEFAULT_POLL_MS);
  const commandPollMs = Number(options.command_poll_ms || 1000);
  const heartbeatMs = Number(options.heartbeat_ms || process.env.NODE_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS);
  const active = new Map();
  const pending = [];
  let normalActive = 0;
  let dispatched = 0;
  let stopPolling = false;
  let pollBusy = false;
  let heartbeatBusy = false;
  const isControlJob = (job) => {
    const kind = job?.payload?.kind;
    return kind === "runner.cancel" || kind === "runner.approval" || kind === "runner.questions" || kind === "runner.question.reply" || kind === "runner.question.reject" || kind === "runner.bot-receipts" || kind === "bot-receipts" || kind === "bot.receipts";
  };
  const postResult = async (job, body) => {
    await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(job.id)}/result`, { method: "POST", token: config.nodeSecret, body });
  };
  const startJob = (job) => {
    const control = isControlJob(job);
    if (!control) normalActive += 1;
    const task = (async () => {
      try {
        const result = await executeRunner(job, config, async (progress) => {
          await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/${encodeURIComponent(job.id)}/progress`, { method: "POST", token: config.nodeSecret, body: { result: progress } });
        });
        await postResult(job, { ok: true, result });
      } catch (error) {
        await postResult(job, { ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        active.delete(job.id);
        if (!control) normalActive -= 1;
      }
    })().catch((error) => {
      // A failed result delivery is already represented by the leased job;
      // avoid an unhandled rejection taking down sibling workers.
      process.stderr.write(`node-agent: result delivery failed (${error instanceof Error ? error.message : String(error)})\n`);
    });
    active.set(job.id, task);
    return task;
  };
  const heartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/heartbeat`, { method: "POST", token: config.nodeSecret, body: { agentVersion: await agentVersion(), capabilities: await liveCapabilities(config) } });
    } catch { /* the next heartbeat retries while the agent remains alive */ }
    finally { heartbeatBusy = false; }
  };
  const lease = async () => {
    if (pollBusy) return null;
    pollBusy = true;
    try { return (await jsonFetch(`${base}/${encodeURIComponent(config.nodeId)}/jobs/poll`, { token: config.nodeSecret })).job || null; }
    finally { pollBusy = false; }
  };
  const keepAlive = setInterval(() => { heartbeat().catch(() => undefined); }, heartbeatMs);
  const commandPoll = setInterval(async () => {
    // Poll while all worker slots are occupied so high-priority commands and
    // receipt acknowledgements remain responsive. A normal job leased here is
    // held until a worker slot becomes free.
    if (stopPolling || normalActive < maxParallelJobs || pollBusy || !active.size) return;
    try {
      const job = await lease();
      if (!job) return;
      dispatched += 1;
      if (isControlJob(job)) startJob(job);
      else pending.push(job);
    } catch { /* the main loop remains authoritative if command polling fails */ }
  }, commandPollMs);
  try {
    await heartbeat();
    while (!stopPolling) {
      if (localRunnerError) throw localRunnerError;
      if (options.once && dispatched > 0) { stopPolling = true; break; }
      const maxJobs = Number(options.max_jobs || 0);
      if (maxJobs > 0 && dispatched >= maxJobs) { stopPolling = true; break; }
      if (await updateLocked(file)) { await sleep(250); continue; }
      if (normalActive >= maxParallelJobs) { await sleep(Math.min(pollMs, commandPollMs)); continue; }
      const queued = pending.shift();
      const job = queued || await lease();
      if (job) {
        if (!queued) dispatched += 1;
        startJob(job);
        if (options.once || maxJobs > 0 && dispatched >= maxJobs) stopPolling = true;
        continue;
      }
      if (options.once) { stopPolling = true; break; }
      await sleep(pollMs);
    }
    // Once/max_jobs stop accepting jobs, but already leased work must report
    // its result before the agent exits.
    while (active.size || pending.length) {
      while (pending.length && normalActive < maxParallelJobs) startJob(pending.shift());
      if (active.size) await Promise.race(active.values());
      else await sleep(10);
    }
  } finally {
    clearInterval(keepAlive);
    clearInterval(commandPoll);
  }
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

export { availableLoopbackPort, capabilities, controlBase, executeRunner, register, run, waitForOwnedRunner };
