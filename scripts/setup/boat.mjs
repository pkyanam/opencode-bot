#!/usr/bin/env node
/**
 * Boat lifecycle adapter. It deliberately has no Cloudflare dependencies.
 *
 * The standalone installer supplies a verified release bundle. This module only
 * transfers that bundle after its digest has been checked, starts the app as a
 * systemd service, and records the owned sandbox id. All command output is
 * treated as sensitive unless explicitly parsed; tokens are never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export const BOAT_API_URL = "https://boat.dev/api/v1";
export const DEFAULT_PORT = 8789;
export const DEFAULT_TYPE = "default";
// The app is a long-running service. Boat's CLI default is one hour, so make
// the intended lifetime explicit instead of inheriting that surprising
// default. Paid accounts can disable auto-stop; trial accounts receive Boat's
// documented trial_auto_stop_required error and must opt into --ttl.
export const DEFAULT_TTL = null;
export const DEFAULT_HOST_ACCESS = "public";
export const MAX_BOAT_EXEC_TIMEOUT_SECONDS = 600;
export const VALID_TYPES = Object.freeze(["small", "default", "large", "xlarge"]);

function integerOption(name, value, { min, max }) {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= min && value <= max) return value;
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  }
  throw new Error(`${name} must be an integer between ${min} and ${max}`);
}

export function validateBoatOptions({ type = DEFAULT_TYPE, ttl = DEFAULT_TTL, port = DEFAULT_PORT, hostAccess = DEFAULT_HOST_ACCESS } = {}) {
  if (!VALID_TYPES.includes(type)) throw new Error(`type must be one of: ${VALID_TYPES.join(", ")}`);
  const normalizedTtl = ttl === null ? null : integerOption("ttl", ttl, { min: 1, max: 2_592_000 });
  const normalizedPort = integerOption("port", port, { min: 1, max: 65_535 });
  if (!["public", "private"].includes(hostAccess)) throw new Error("host access must be public or private");
  return { type, ttl: normalizedTtl, port: normalizedPort, hostAccess };
}

function defaultStateDir() { return process.env.OCBOT_BOAT_STATE_DIR || resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share"), "opencode-bot", "boat"); }
export function paths(stateDir = defaultStateDir()) {
  return { stateDir, state: resolve(stateDir, "state.json"), secrets: resolve(stateDir, "secrets.json") };
}

export function commandRunner({ cwd = process.cwd(), env = process.env, runner = spawnSync } = {}) {
  return (name, args = [], options = {}) => {
    const result = runner(name, args, { cwd, env, encoding: "utf8", timeout: options.timeout ?? 120000, input: options.input, maxBuffer: 32 * 1024 * 1024, stdio: options.inherit ? "inherit" : "pipe" });
    if (result.error) throw new Error(safeCommandFailure(name, result));
    if (result.status !== 0) {
      const detail = options.sensitive ? "" : `${result.stderr || result.stdout || ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 800);
      throw new Error(options.sensitive ? safeCommandFailure(name, result) : `${name} failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
    }
    return result;
  };
}

export function safeCommandFailure(name, result) {
  const text = `${result?.error?.message || ""} ${result?.stderr || ""} ${result?.stdout || ""}`.toLowerCase();
  if (/trial_auto_stop_required|free trial.*auto.stop|payment method.*auto.stop/.test(text)) return `${name} requires a paid Boat plan for a persistent sandbox; rerun with --ttl or add a payment method`;
  if (/unknown option|unrecognized option|invalid option/.test(text)) return `${name} rejected an option; update the Boat CLI and retry`;
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || /timed[ -]+out|deadline exceeded|execution timeout|etimedout/.test(text)) return `${name} timed out; retry or inspect the Boat CLI connection`;
  if (/unauthori[sz]|forbidden|not logged|login required|api key/.test(text)) return `${name} authentication failed; run boat login or provide BOAT_API_KEY`;
  if (/connect|network|dns|econn|fetch failed|unreachable/.test(text)) return `${name} could not reach Boat; check network access and retry`;
  return `${name} failed (exit ${result?.status ?? "unknown"})`;
}

function report(progress, message) { if (typeof progress === "function") progress(message); }

function ensureDir(dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
function secureWrite(file, text) {
  ensureDir(dirname(file));
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, file); chmodSync(file, 0o600);
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
function saveState(file, state) { secureWrite(file, `${JSON.stringify(state, null, 2)}\n`); }
function jsonLines(text) { return `${text || ""}`.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
function latestEvent(result) { return jsonLines(`${result.stdout}\n${result.stderr}`).at(-1) || {}; }
function sha256(file) { const hash = createHash("sha256"); hash.update(readFileSync(file)); return hash.digest("hex"); }

export function verifyBundle(file, expectedSha256) {
  if (!file || !existsSync(file)) throw new Error("verified Boat release bundle is required; pass --bundle or OCBOT_BOAT_BUNDLE");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || "")) throw new Error("Boat bundle sha256 is required; set --bundle-sha256 or OCBOT_BOAT_BUNDLE_SHA256");
  const actual = sha256(file);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error("Boat release bundle sha256 mismatch");
  return { file: resolve(file), sha256: actual };
}

export function readMemoryProviderFile(file) {
  if (!file) return undefined;
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`memory provider file is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory provider file must contain a JSON object");
  for (const key of ["llmBaseUrl", "llmApiKey", "llmModel"]) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`memory provider field ${key} is required`);
  let url;
  try { url = new URL(value.llmBaseUrl); } catch { throw new Error("memory provider llmBaseUrl must be a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("memory provider llmBaseUrl must use HTTPS (or loopback HTTP)");
  return { llmBaseUrl: value.llmBaseUrl.trim(), llmApiKey: value.llmApiKey, llmModel: value.llmModel.trim() };
}

function authenticate(run, env = process.env) {
  const key = env.BOAT_API_KEY;
  if (key) run("boat", ["login", "--key-stdin", "--json", "--no-update"], { input: `${key}\n`, sensitive: true });
  const status = run("boat", ["status", "--json", "--no-update"], { sensitive: true });
  return status;
}

function sandboxIdFromState(state) { return state.sandboxId || state.resources?.sandboxId; }
function info(run, id) {
  const result = run("boat", ["info", id || "current", "--json", "--no-update"], { sensitive: true });
  return latestEvent(result).sandbox || latestEvent(result);
}

function createSandbox(run, { type, ttl }) {
  const args = ["new", "--no-env", "--type", type, "--json", "--no-update"];
  if (ttl === null) args.push("--no-auto-stop"); else args.push("--ttl", String(ttl));
  const result = run("boat", args, { timeout: 900000, sensitive: true });
  const event = jsonLines(result.stdout).find(item => item.event === "ready") || latestEvent(result);
  const id = event.id || event.sandbox?.id;
  if (!id) throw new Error("Boat did not return a ready sandbox id");
  return { id, event };
}

function resumeSandbox(run, id, { ttl }) {
  const args = ["resume", id, "--json", "--no-update"];
  if (ttl === null) args.push("--no-auto-stop"); else if (ttl !== undefined) args.push("--ttl", String(ttl));
  const result = run("boat", args, { timeout: 900000, sensitive: true });
  return { id, event: latestEvent(result) };
}

function extendSandbox(run, id, { ttl }) {
  const args = ["extend", id, "--json", "--no-update"];
  if (ttl === null) args.push("--no-auto-stop"); else args.push("--ttl", String(ttl));
  const result = run("boat", args, { timeout: 120000, sensitive: true });
  return { id, event: latestEvent(result) };
}

function verifyLifetime(run, id, ttl) {
  if (ttl !== null) return;
  let current;
  try { current = info(run, id); } catch (error) {
    throw new Error(`could not verify persistent Boat sandbox lifetime: ${error.message}`);
  }
  const source = current?.sandbox && typeof current.sandbox === "object" ? current.sandbox : current;
  if (!Object.prototype.hasOwnProperty.call(source, "archiveAfter")) throw new Error("Boat persistent lifetime verification failed: info did not include archiveAfter");
  if (source.archiveAfter !== null) throw new Error(`Boat persistent lifetime verification failed: archiveAfter is ${String(source.archiveAfter)}`);
  if (["stopped", "archived"].includes(source.state)) throw new Error(`Boat persistent lifetime verification failed: sandbox is ${source.state}`);
  return current;
}

function execRemote(run, id, command, options = {}) {
  // Boat CLI forwards the command as one shell string. Passing argv elements
  // separately makes its joiner lose quoting (notably for `sh -lc` scripts).
  const commandText = command.length === 1 ? command[0] : command.map(shellQuote).join(" ");
  const timeoutSeconds = options.timeoutSeconds ?? MAX_BOAT_EXEC_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_BOAT_EXEC_TIMEOUT_SECONDS) throw new Error(`Boat exec timeout must be between 1 and ${MAX_BOAT_EXEC_TIMEOUT_SECONDS} seconds`);
  const result = run("boat", ["exec", id, "--timeout", String(timeoutSeconds), "--no-update", "--", commandText], { timeout: options.timeout ?? (timeoutSeconds * 1000 + 60000), sensitive: true });
  // Depending on the Boat CLI version, a remote command failure is either
  // reflected in the process exit status or returned as JSON while the CLI
  // itself exits zero. Honor both forms so cleanup cannot mask setup failure.
  for (const event of jsonLines(result.stdout)) {
    const exitCode = event.exitCode ?? event.data?.exitCode ?? event.command?.exitCode;
    if (Number.isInteger(exitCode) && exitCode !== 0) throw new Error(`Boat remote command failed (exit ${exitCode})`);
  }
  return result;
}

function detachedEvent(result) { return jsonLines(`${result.stdout}\n${result.stderr}`).at(-1) || {}; }

function pollRemoteProcess(run, id, pid, { timeoutMs = 900000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const polled = run("boat", ["exec", id, "--status", String(pid), "--json", "--no-update"], { timeout: 60000, sensitive: true });
    const event = detachedEvent(polled);
    if (event.running === true || event.status === "running") { run("sleep", ["2"], { timeout: 5000, sensitive: true }); continue; }
    if (event.known === false || event.status === "unknown") throw new Error(`Boat bootstrap process ${pid} status is unknown; temporary files are retained for recovery`);
    const exitCode = event.exitCode ?? event.data?.exitCode ?? event.command?.exitCode;
    if (event.status === "exited" || event.finishedAt || Number.isInteger(exitCode)) return { pid, event };
    run("sleep", ["2"], { timeout: 5000, sensitive: true });
  }
  throw new Error(`Boat bootstrap process ${pid} did not finish within ${Math.ceil(timeoutMs / 60000)} minutes; temporary files are retained for recovery`);
}

export function readCompletionMarker(run, id, marker) {
  if (!marker) return undefined;
  const result = run("boat", ["exec", id, "--timeout", "30", "--json", "--no-update", "--", `sudo cat ${shellQuote(marker)}`], { timeout: 60000, sensitive: true });
  for (const event of jsonLines(result.stdout)) {
    const nested = jsonLines(event.stdout).find(value => (value.status === "terminal" || value.status === "failed") && Number.isInteger(value.exitCode) && value.exitCode >= 0);
    if (nested) return nested;
    if ((event.status === "terminal" || event.status === "failed") && Number.isInteger(event.exitCode) && event.exitCode >= 0) return event;
  }
  return undefined;
}

function execRemoteDetached(run, id, command, { timeoutMs = 900000, onPid, onTerminal } = {}) {
  const commandText = command.length === 1 ? command[0] : command.map(shellQuote).join(" ");
  const started = run("boat", ["exec", id, "--detach", "--json", "--no-update", "--", commandText], { timeout: 60000, sensitive: true });
  const launch = detachedEvent(started);
  const pid = launch.pid ?? launch.processId;
  if (!Number.isInteger(pid)) throw new Error("Boat detached bootstrap did not return a process id");
  onPid?.(pid);
  const completed = pollRemoteProcess(run, id, pid, { timeoutMs });
  onTerminal?.(completed);
  const exitCode = completed.event.exitCode ?? completed.event.data?.exitCode ?? completed.event.command?.exitCode;
  if (Number.isInteger(exitCode) && exitCode !== 0) throw new Error(`Boat remote command failed (exit ${exitCode})`);
  return completed;
}

function shellQuote(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

function installBundle(run, id, bundle, { port, appToken, stateDir, memoryProvider, progress, onDetachedPid, onDetachedTerminal }) {
  const runSuffix = randomUUID().replace(/-/g, "");
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  const remote = `/tmp/opencode-bot-bundle-${safeId}-${runSuffix}.tar.gz`;
  const remoteStage = `/tmp/opencode-bot-stage-${safeId}-${runSuffix}`;
  const remoteMarker = `/var/lib/opencode-bot/boat-bootstrap-${safeId}-${runSuffix}.json`;
  // Transfer the token as a mode-0600 file; never put it in process arguments,
  // shell history, or command output. The verified bundle setup reads this path.
  const localSecret = resolve(stateDir, `.app-token-${process.pid}`);
  const remoteSecret = `/tmp/opencode-bot-app-token-${safeId}-${runSuffix}`;
  secureWrite(localSecret, `${appToken}\n`);
  let remoteMemory;
  let localMemory;
  let detachedCleanupSafe = true;
  try {
    report(progress, "uploading release");
    run("boat", ["scp", bundle.file, `${id}:${remote}`, "--no-update"], { timeout: 900000, sensitive: true });
    const unpack = `set -e; sudo rm -rf ${shellQuote(remoteStage)}; sudo install -d -m 0755 ${shellQuote(remoteStage)}; sudo tar -xzf ${shellQuote(remote)} -C ${shellQuote(remoteStage)} --no-same-owner`;
    execRemote(run, id, ["sh", "-lc", unpack], { timeoutSeconds: 600, timeout: 660_000 });
    if (memoryProvider) {
      remoteMemory = `/tmp/opencode-bot-memory-provider-${safeId}-${runSuffix}`;
      localMemory = resolve(stateDir, `.memory-provider-${process.pid}`);
      secureWrite(localMemory, `${JSON.stringify(memoryProvider)}\n`);
      try { run("boat", ["scp", localMemory, `${id}:${remoteMemory}`, "--no-update"], { timeout: 120000, sensitive: true }); }
      finally { rmSync(localMemory, { force: true }); }
      execRemote(run, id, ["chmod", "600", remoteMemory], { timeoutSeconds: 30, timeout: 60000 });
    }
    run("boat", ["scp", localSecret, `${id}:${remoteSecret}`, "--no-update"], { timeout: 120000, sensitive: true });
    rmSync(localSecret, { force: true });
    execRemote(run, id, ["chmod", "600", remoteSecret], { timeoutSeconds: 30, timeout: 60000 });
    // The verified bundle contract supplies this script. It must install the
    // normal app and an enabled systemd unit, and must not print its token.
    report(progress, "installing app");
    const memoryArg = remoteMemory ? ` APP_MEMORY_CONFIG_FILE=${shellQuote(remoteMemory)}` : "";
    const cleanupCommand = [remoteSecret, remoteMemory].filter(Boolean).map(shellQuote).join(" ");
    const setup = `set -e; trap "sudo rm -f ${cleanupCommand}" EXIT; sudo APP_PORT=${port} APP_TOKEN_FILE=${shellQuote(remoteSecret)}${memoryArg} APP_BUNDLE_DIR=${shellQuote(remoteStage)} APP_BOOTSTRAP_MARKER=${shellQuote(remoteMarker)} bash ${shellQuote(`${remoteStage}/boat/setup.sh`)}`;
    detachedCleanupSafe = false;
    execRemoteDetached(run, id, ["sh", "-lc", setup], { timeoutMs: 900000, onPid: pid => onDetachedPid?.({ pid, sandboxId: id, paths: { remote, remoteStage, remoteSecret, remoteMemory, remoteMarker } }), onTerminal: () => { detachedCleanupSafe = true; onDetachedTerminal?.(); } });
  } finally {
    rmSync(localSecret, { force: true });
    if (localMemory) rmSync(localMemory, { force: true });
    // Never remove bootstrap inputs while a detached process may still use them.
    if (detachedCleanupSafe) {
      try { execRemote(run, id, ["sh", "-lc", `sudo rm -rf ${shellQuote(remoteStage)} ${shellQuote(remote)} ${shellQuote(remoteSecret)} ${shellQuote(remoteMarker)}${remoteMemory ? ` ${shellQuote(remoteMemory)}` : ""}`], { timeoutSeconds: 30, timeout: 60000 }); } catch {}
    }
  }
}

function verifyApp(run, url, token) {
  if (!url) throw new Error("Boat host did not return an app URL");
  const endpoint = `${url.replace(/\/$/, "")}/api/state`;
  run("curl", ["--fail-with-body", "--silent", "--show-error", "--max-time", "30", "-H", `Authorization: Bearer ${token}`, endpoint], { timeout: 60000, sensitive: true });
  return endpoint;
}

export function install({ run, stateDir = defaultStateDir(), bundle, bundleSha256, type = DEFAULT_TYPE, ttl = DEFAULT_TTL, port = DEFAULT_PORT, appToken, hostAccess = DEFAULT_HOST_ACCESS, open = false, memoryProviderFile, env = process.env, progress, reuseStoredType = true } = {}) {
  const execute = run || commandRunner({ env });
  report(progress, "preparing runtime");
  const p = paths(stateDir); ensureDir(stateDir);
  let state = readJson(p.state, { schemaVersion: 1, provider: "boat", stateDir, journal: [] });
  if (reuseStoredType && VALID_TYPES.includes(state.type)) type = state.type;
  ({ type, ttl, port, hostAccess } = validateBoatOptions({ type, ttl, port, hostAccess }));
  const memoryProvider = readMemoryProviderFile(memoryProviderFile);
  const verified = verifyBundle(bundle || env.OCBOT_BOAT_BUNDLE, bundleSha256 || env.OCBOT_BOAT_BUNDLE_SHA256);
  authenticate(execute, env);
  if (state.provider !== "boat") throw new Error("state file belongs to another provider");
  const existingSecrets = readJson(p.secrets, {});
  appToken = appToken || existingSecrets.appToken || env.APP_TOKEN || randomBytes(32).toString("base64url");
  let id = sandboxIdFromState(state); let current;
  if (id) {
    try { current = info(execute, id); } catch { current = undefined; }
    const actualType = current?.type || current?.sandbox?.type || current?.machine?.type || state.type;
    if (!reuseStoredType && actualType && type !== actualType) throw new Error(`owned Boat sandbox ${id} is ${actualType}; changing to ${type} requires an explicit boat resume --type operation`);
    if (current?.state === "error") throw new Error(`owned Boat sandbox ${id} is in error; inspect boat info ${id}`);
    if (current && ["stopped", "archived"].includes(current.state)) resumeSandbox(execute, id, { ttl });
    else if (current) extendSandbox(execute, id, { ttl });
  } else {
    ({ id } = createSandbox(execute, { type, ttl }));
  }
  if (!id) throw new Error("Boat sandbox id is missing");
  verifyLifetime(execute, id, ttl);
  if (state.remoteProcess?.pid) {
    report(progress, "recovering previous bootstrap");
    const pending = state.remoteProcess;
    try { pollRemoteProcess(execute, pending.sandboxId || id, pending.pid, { timeoutMs: 900000 }); }
    catch (error) {
      const marker = readCompletionMarker(execute, pending.sandboxId || id, pending.paths?.remoteMarker);
      if (!marker) throw error;
    }
    const pathsToClean = pending.paths || {};
    try { execRemote(execute, pending.sandboxId || id, ["sh", "-lc", `sudo rm -rf ${Object.values(pathsToClean).filter(Boolean).map(shellQuote).join(" ")}`], { timeoutSeconds: 30, timeout: 60000 }); } catch {}
    delete state.remoteProcess; saveState(p.state, state);
  }
  state.sandboxId = id; state.type = type; state.ttl = ttl; state.port = port; state.bundleSha256 = verified.sha256; state.installationState = "provisioning"; delete state.host; state.updatedAt = new Date().toISOString();
  state.journal.push({ action: "sandbox", id, at: state.updatedAt }); saveState(p.state, state);
  secureWrite(p.secrets, `${JSON.stringify({ appToken })}\n`);
  const onDetachedPid = process => { state.remoteProcess = { ...process, startedAt: new Date().toISOString() }; saveState(p.state, state); };
  const onDetachedTerminal = () => { delete state.remoteProcess; saveState(p.state, state); };
  installBundle(execute, id, verified, { port, appToken, stateDir, memoryProvider, progress, onDetachedPid, onDetachedTerminal });
  report(progress, "hosting app");
  const hostArgs = ["host", id, String(port), hostAccess === "private" ? "--private" : "--public", "--json", "--no-update"];
  const hosted = execute("boat", hostArgs, { sensitive: true });
  const host = latestEvent(hosted); report(progress, "checking authenticated health"); verifyApp(execute, host.url, appToken);
  state.host = { url: redactUrl(host.url), port, access: host.access || hostAccess }; state.installationState = "installed"; state.updatedAt = new Date().toISOString(); saveState(p.state, state);
  if (host.url) {
    const connectionUrl = new URL(host.url);
    connectionUrl.hash = `connect=${encodeURIComponent(appToken)}`;
    const escapedUrl = connectionUrl.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    const handoffPath = resolve(stateDir, "open.html");
    secureWrite(handoffPath, `<!doctype html><meta http-equiv="refresh" content="0;url=${escapedUrl}"><a href="${escapedUrl}">Connect to opencode bot</a>\n`);
    report(progress, `Owner connection saved to ${handoffPath}; open this file to reconnect`);
    if (open) openBrowser(execute, connectionUrl.toString());
  }
  return { id, url: host.url, statePath: p.state };
}

export function openBrowser(run, url, platform = process.platform) {
  if (platform === "win32") return run("cmd", ["/c", "start", "", url], { sensitive: true });
  return run(platform === "darwin" ? "open" : "xdg-open", [url], { sensitive: true });
}

function redactUrl(url) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/token|secret|key|auth/i.test(key)) parsed.searchParams.set(key, "REDACTED");
    if (parsed.hash) parsed.hash = parsed.hash.replace(/(token|secret|key|auth)=([^&]*)/gi, "$1=REDACTED");
    return parsed.toString();
  } catch { return "REDACTED"; }
}

export function status({ run, stateDir = defaultStateDir() } = {}) {
  const execute = run || commandRunner(); const p = paths(stateDir); const state = readJson(p.state, null);
  if (!state?.sandboxId) return { installed: false, statePath: p.state };
  const current = info(execute, state.sandboxId);
  return { installed: state.installationState === "installed", sandboxId: state.sandboxId, state: current.state, installationState: state.installationState || "unknown", host: state.host, statePath: p.state };
}

export function uninstall({ run, stateDir = defaultStateDir(), yes = false } = {}) {
  const execute = run || commandRunner(); const p = paths(stateDir); const state = readJson(p.state, null);
  if (!state?.sandboxId) return { removed: false, reason: "no owned sandbox" };
  if (!yes) throw new Error("uninstall permanently deletes the owned Boat sandbox; pass --yes");
  execute("boat", ["delete", state.sandboxId, "--yes", "--json", "--no-update"], { sensitive: true });
  rmSync(stateDir, { recursive: true, force: true });
  return { removed: true, sandboxId: state.sandboxId };
}

function argValue(argv, flag) { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; }
function lifetimeLabel(ttl) {
  if (ttl === null) return "keep running (no auto-stop; billed while active)";
  if (ttl % 3600 === 0) { const hours = ttl / 3600; return `${hours} hour${hours === 1 ? "" : "s"} auto-stop`; }
  if (ttl % 60 === 0) { const minutes = ttl / 60; return `${minutes} minute${minutes === 1 ? "" : "s"} auto-stop`; }
  return `${ttl} second${ttl === 1 ? "" : "s"} auto-stop`;
}
export async function main(argv = process.argv.slice(2)) {
  const command = argv.includes("--uninstall") ? "uninstall" : (argv.find(value => !value.startsWith("-")) || "status");
  const env = process.env; const options = { env, stateDir: argValue(argv, "--state-dir"), run: commandRunner({ env }) };
  if (command === "install") {
    let uiRuntime;
    try { uiRuntime = await import("./installer-ui.mjs"); } catch { uiRuntime = undefined; }
    const ttyHandle = uiRuntime?.openInstallerTTY?.({ output: process.stderr });
    const nonInteractive = env.OCBOT_NONINTERACTIVE === "1" || argv.includes("--yes");
    const ui = uiRuntime?.createInstallerUI?.({ input: ttyHandle?.tty || process.stdin, output: process.stderr, tty: ttyHandle?.tty || process.stdin, interactive: Boolean(ttyHandle) && !nonInteractive });
    const removeCleanup = ui && uiRuntime?.installCleanup ? uiRuntime.installCleanup(ui) : undefined;
    try {
      ui?.step("Preparing Boat runtime");
      const savedType = readJson(paths(options.stateDir).state, {}).type;
      let selectedType = argValue(argv, "--type") || (VALID_TYPES.includes(savedType) ? savedType : DEFAULT_TYPE);
      let choseTypeInteractively = false;
      if (!argValue(argv, "--type") && ui?.interactive) selectedType = await ui.select("Choose Boat VM size", [
        { label: "small — 2 vCPU, 4 GB", value: "small" },
        { label: "default — 4 vCPU, 8 GB (recommended)", value: "default" },
        { label: "large — 8 vCPU, 16 GB", value: "large" },
        { label: "xlarge — 16 vCPU, 32 GB (plan/allocation requirements)", value: "xlarge" },
      ], { defaultIndex: VALID_TYPES.indexOf(selectedType) });
      if (!argValue(argv, "--type") && ui?.interactive) choseTypeInteractively = true;
      const explicitTtl = argValue(argv, "--ttl");
      let selectedTtl = argv.includes("--no-auto-stop") ? null : (explicitTtl || DEFAULT_TTL);
      if (!argv.includes("--no-auto-stop") && explicitTtl === undefined && ui?.interactive) {
        selectedTtl = await ui.select("Choose Boat sandbox lifetime", [
          { label: "Keep running — no auto-stop (requires a paid plan)", value: null },
          { label: "1 hour auto-stop", value: 3600 },
          { label: "2 hours auto-stop", value: 7200 },
        ], { defaultIndex: 0 });
      }
      const port = argValue(argv, "--port") || DEFAULT_PORT;
      const hostAccess = argv.includes("--private") ? "private" : DEFAULT_HOST_ACCESS;
      if (ui?.interactive) {
        ui.step(`Review: ${selectedType} VM, ${lifetimeLabel(selectedTtl)}, port ${port}, ${hostAccess} hosting`);
        const decision = await ui.select("Install Boat app?", [
          { label: "Install", value: "install" },
          { label: "Cancel", value: "cancel" },
        ]);
        if (decision === "cancel") throw new Error("Boat install cancelled");
      }
      const result = install({ ...options, bundle: argValue(argv, "--bundle"), bundleSha256: argValue(argv, "--bundle-sha256"), type: selectedType, reuseStoredType: !argValue(argv, "--type") && !choseTypeInteractively, ttl: selectedTtl, port, hostAccess, open: argv.includes("--open"), memoryProviderFile: argValue(argv, "--memory-provider-file"), progress: message => { if (ui) ui.progress(message); else console.error(`[boat] ${message}`); } });
      ui?.success("Boat app is ready"); result.url = redactUrl(result.url); return void console.log(JSON.stringify(result));
    } finally { removeCleanup?.(); ttyHandle?.close?.(); }
  }
  if (command === "status") return void console.log(JSON.stringify(status(options)));
  if (command === "uninstall") return void console.log(JSON.stringify(uninstall({ ...options, yes: argv.includes("--yes") })));
  if (command === "doctor") return void console.log(JSON.stringify({ boat: options.run("boat", ["status", "--json", "--no-update"], { sensitive: true }).status === 0 }));
  throw new Error(`unknown Boat command: ${command}`);
}

// Downloaded scripts may live under macOS /var (a symlink to /private/var),
// and TMPDIR commonly ends in a slash. Compare canonical paths, not raw URLs.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Boat installer failed: ${error.message}`); process.exitCode = 1; });
