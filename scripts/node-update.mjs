#!/usr/bin/env node
/** Update an already paired outbound node without consuming a pairing token. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVICE = "opencode-bot-node";
const SERVICE_LABEL = "com.opencode.bot.node";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) { out._.push(item); continue; }
    const key = item.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const home = () => process.env.HOME || process.env.USERPROFILE || ".";
const defaults = () => ({
  nodeHome: process.env.OCBOT_NODE_HOME || path.join(home(), ".local", "share", "opencode-bot-node"),
  config: process.env.OCBOT_NODE_CONFIG || path.join(process.env.OCBOT_NODE_CONFIG_DIR || path.join(home(), ".config", "opencode-bot-node"), "node.json"),
  releaseBase: process.env.OCBOT_RELEASE_BASE || "https://github.com/pkyanam/opencode-bot",
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio || "ignore", env: { ...process.env, ...(options.env || {}) } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}
function runOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function commandSucceeds(command, args) {
  try { await run(command, args); return true; } catch { return false; }
}

function serviceCommands() {
  if (process.platform === "darwin") return {
    active: ["launchctl", "print", `gui/${process.getuid?.() || 0}/${SERVICE_LABEL}`],
    stop: ["launchctl", "bootout", `gui/${process.getuid?.() || 0}/${SERVICE_LABEL}`],
    start: ["launchctl", "bootstrap", `gui/${process.getuid?.() || 0}`, path.join(home(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)],
    validate: ["launchctl", "print", `gui/${process.getuid?.() || 0}/${SERVICE_LABEL}`],
  };
  if (process.platform === "win32") return {
    active: ["schtasks", "/Query", "/TN", "OpenCode Bot Node"], stop: ["schtasks", "/End", "/TN", "OpenCode Bot Node"],
    start: ["schtasks", "/Run", "/TN", "OpenCode Bot Node"], validate: ["schtasks", "/Query", "/TN", "OpenCode Bot Node"],
  };
  return { active: ["systemctl", "--user", "is-active", `${SERVICE}.service`], stop: ["systemctl", "--user", "stop", `${SERVICE}.service`], start: ["systemctl", "--user", "start", `${SERVICE}.service`], validate: ["systemctl", "--user", "is-active", `${SERVICE}.service`] };
}

async function fetchBytes(url) {
  if (url.startsWith("file://")) return readFile(new URL(url));
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{40}$/.test(manifest.commit || "") || manifest.archive?.file !== "node-bundle.tar.gz" || !/^[0-9a-f]{64}$/.test(manifest.archive.sha256 || "") || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size <= 0) throw new Error("invalid node release manifest");
}

async function serviceWasActive(commands) {
  if (process.platform !== "win32") return commandSucceeds(commands.active[0], commands.active.slice(1));
  try { return /\bstatus:\s*running\b/i.test(await runOutput(commands.active[0], [...commands.active.slice(1), "/FO", "LIST"])); } catch { return false; }
}
async function stopService(commands) { await commandSucceeds(commands.stop[0], commands.stop.slice(1)); }
async function startService(commands) { await run(commands.start[0], commands.start.slice(1)); }
async function waitForStopped(commands) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await serviceWasActive(commands))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("node service did not stop cleanly; refusing to replace a running bundle");
}
async function validateService(commands) {
  if (!(await commandSucceeds(commands.validate[0], commands.validate.slice(1)))) throw new Error("node service did not become active after update");
}

async function runnerRequest(config, pathname, method = "GET") {
  const runner = String(config.runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = new URL(`${runner}${pathname}`);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("saved runner URL is not loopback");
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${config.runnerToken}`, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${body?.error || "runner request failed"}`);
  return body;
}

async function quiesceRunner(config) {
  const health = await runnerRequest(config, "/health");
  if (health?.ok !== true || health?.service !== "opencode2-runner" || typeof health.instanceId !== "string") throw new Error("runner health identity check failed");
  const state = await runnerRequest(config, "/checkpoint/state");
  if (state.instanceId !== health.instanceId) throw new Error("runner identity changed during update preparation");
  if (state.activeRuns > 0 || state.humanControlActive || state.nativeTerminalActive || state.quiesced) throw new Error("node has active work; wait for it to finish before updating");
  await runnerRequest(config, "/checkpoint/quiesce", "POST");
  return health.instanceId;
}
async function resumeRunner(config) { await runnerRequest(config, "/checkpoint/resume", "POST"); }
async function acquireUpdateLock(file) {
  try { await writeFile(file, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 }); return; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const current = JSON.parse(await readFile(file, "utf8"));
      if (Number.isInteger(current.pid) && current.pid !== process.pid) process.kill(current.pid, 0);
      throw new Error("another node update is already in progress");
    } catch (probeError) {
      if (probeError?.code !== "ESRCH") throw probeError;
      await rm(file, { force: true });
      return acquireUpdateLock(file);
    }
  }
}
async function validateReplacementRunner(configFile, previousInstanceId) {
  const fresh = JSON.parse(await readFile(configFile, "utf8"));
  const health = await runnerRequest(fresh, "/health");
  if (health?.ok !== true || health?.service !== "opencode2-runner" || typeof health.instanceId !== "string" || health.instanceId === previousInstanceId) throw new Error("updated runner did not present a fresh authenticated identity");
  const state = await runnerRequest(fresh, "/checkpoint/state");
  if (state.instanceId !== health.instanceId || state.activeRuns > 0 || state.humanControlActive || state.nativeTerminalActive) throw new Error("updated runner readiness check failed");
  return fresh;
}

function hasActiveWork(configFile) {
  if (process.env.OCBOT_NODE_ACTIVE_WORK === "1") return true;
  const marker = path.join(path.dirname(configFile), "state", "active-work.json");
  return marker;
}

async function refuseActiveWork(configFile) {
  if (process.env.OCBOT_NODE_ACTIVE_WORK === "1") throw new Error("node has active work; wait for it to finish before updating");
  try { await stat(hasActiveWork(configFile)); throw new Error("node has active work; wait for it to finish before updating"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function installDependencies(stage, nodeHome, skip = false) {
  if (skip) return;
  const npm = process.env.OCBOT_NPM || (process.platform === "win32" ? "npm.cmd" : "npm");
  await run(npm, ["ci", "--prefix", path.join(stage, "runner"), "--omit=dev", "--no-audit", "--fund=false"]);
  await rm(path.join(stage, "node_modules"), { recursive: true, force: true });
  // Keep runner/node_modules in place and expose the historical bundle alias.
  await symlink("runner/node_modules", path.join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const browserRoot = path.join(nodeHome, "browsers");
  await run(npm, ["exec", "--prefix", path.join(stage, "runner"), "--offline", "--", "playwright", "install", "--no-shell", "chromium"], { env: { PLAYWRIGHT_BROWSERS_PATH: browserRoot } });
}

export async function updateNode(options = {}) {
  const base = { ...defaults(), ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const commands = serviceCommands();
  const service = base.serviceAdapter || {
    wasActive: () => serviceWasActive(commands),
    stop: () => stopService(commands),
    waitStopped: () => waitForStopped(commands),
    start: () => startService(commands),
    validate: () => validateService(commands),
  };
  const runner = base.runnerAdapter || {
    quiesce: (config) => quiesceRunner(config),
    replacement: (configFile, previousInstanceId) => validateReplacementRunner(configFile, previousInstanceId),
    resume: (config) => resumeRunner(config),
  };
  await refuseActiveWork(base.config);
  const wasActive = await service.wasActive();
  const saved = JSON.parse(await readFile(base.config, "utf8"));
  if (!saved.nodeId || !saved.nodeSecret || !saved.runnerToken) throw new Error(`node is not registered (config: ${base.config})`);
  const requested = base.version ? `${base.releaseBase}/releases/download/${base.version}/node-bundle-manifest.json` : `${base.releaseBase}/releases/latest/download/node-bundle-manifest.json`;
  const manifest = base.manifest ? JSON.parse(await readFile(base.manifest, "utf8")) : JSON.parse((await fetchBytes(requested)).toString("utf8"));
  validateManifest(manifest);
  const archive = base.archive ? await readFile(base.archive) : await fetchBytes(`${base.releaseBase}/releases/download/${manifest.version}/${manifest.archive.file}`);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== manifest.archive.sha256 || archive.length !== manifest.archive.size) throw new Error("node bundle checksum or size verification failed");
  const work = await mkdtemp(path.join(tmpdir(), "opencode-bot-node-update-"));
  const stage = path.join(base.nodeHome, `.bundle-update-${process.pid}`);
  const backup = path.join(base.nodeHome, `.bundle-backup-${process.pid}`);
  const updateLock = path.join(path.dirname(base.config), "update.lock");
  let lockCreated = false;
  try {
    await rm(stage, { recursive: true, force: true });
    await writeFile(path.join(work, "node-bundle.tar.gz"), archive);
    await mkdir(stage, { recursive: true });
    await run("tar", ["-xzf", path.join(work, "node-bundle.tar.gz"), "-C", stage]);
    await installDependencies(stage, base.nodeHome, base.skipDependencies === true);
    await refuseActiveWork(base.config);
    await mkdir(path.dirname(updateLock), { recursive: true, mode: 0o700 });
    await acquireUpdateLock(updateLock);
    lockCreated = true;
    let quiesced = false;
    let stopped = false;
    let stopInitiated = false;
    let previousInstanceId = "";
    let backupCreated = false;
    try {
      if (wasActive) {
        previousInstanceId = await runner.quiesce(saved);
        quiesced = true;
        stopInitiated = true;
        await service.stop(); await service.waitStopped(); stopped = true;
      }
      await rename(path.join(base.nodeHome, "bundle"), backup); backupCreated = true;
      await rename(stage, path.join(base.nodeHome, "bundle"));
      if (wasActive) {
        await service.start(); await service.validate();
        const fresh = await runner.replacement(base.config, previousInstanceId);
        await runner.resume(fresh);
      }
      await writeFile(path.join(base.nodeHome, "bundle-version.json"), `${JSON.stringify({ version: manifest.version, commit: manifest.commit, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (backupCreated) {
        if (wasActive && (stopped || await service.wasActive())) { await service.stop(); await service.waitStopped().catch(() => undefined); }
        await rm(path.join(base.nodeHome, "bundle"), { recursive: true, force: true });
        await rename(backup, path.join(base.nodeHome, "bundle"));
        if (wasActive) {
          try {
            await service.start(); await service.validate();
            const restored = await runner.replacement(base.config, previousInstanceId);
            await runner.resume(restored);
          }
          catch (restoreError) { throw new Error(`node update failed; the previous bundle was restored at ${path.join(base.nodeHome, "bundle")}, but service restoration failed. Cause: ${restoreError.message}`); }
        }
      } else if (quiesced) {
        if (stopInitiated) {
          try {
            await service.start(); await service.validate();
            const restored = await runner.replacement(base.config, previousInstanceId);
            await runner.resume(restored);
          } catch (restoreError) { throw new Error(`node update failed before bundle swap and service restoration failed: ${restoreError.message}`); }
        } else await runner.resume(JSON.parse(await readFile(base.config, "utf8"))).catch(() => undefined);
      }
      throw new Error(`node update failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { version: manifest.version, commit: manifest.commit };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
    if (lockCreated) await rm(updateLock, { force: true });
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log("Usage: node node-update.mjs [--version vX.Y.Z] [--config FILE] [--node-home DIR]"); process.exit(0); }
  updateNode({ version: args.version, config: args.config, nodeHome: args.node_home, releaseBase: args.release_base, manifest: args.manifest, archive: args.archive }).then((result) => console.log(`updated node to ${result.version}`)).catch((error) => { console.error(`node update: ${error.message}`); process.exitCode = 1; });
}
