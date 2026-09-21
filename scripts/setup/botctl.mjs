#!/usr/bin/env node
/**
 * Small, dependency-free installer/doctor for opencode-bot.
 *
 * `plan` and `doctor` are read-only. `apply` is the only command that writes
 * deployment state or invokes Wrangler. Secrets are generated in memory and
 * are never printed or stored in the deployment journal.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync, createReadStream, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawnSync } from "node:child_process";
import { validateManifest, verifyArchive, downloadReleaseArchive, assertSourceCommit, craneAsset } from "./release.mjs";
import { readOwnership, uninstallPlan, uninstallResources } from "./uninstall.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const valueFlags = new Set(["--config"]);
const positional = argv.find((arg, index) => !arg.startsWith("-") && !(index > 0 && valueFlags.has(argv[index - 1])));
const command = positional ?? (args.has("--apply") ? "apply" : args.has("--plan") ? "plan" : "doctor");
const apply = args.has("--apply");
const install = args.has("--install-missing") || args.has("--install");
const configPath = valueAfter("--config") ?? resolve(root, "infra/deployment.json");
const stateDir = resolve(root, ".opencode-bot");
const statePath = resolve(stateDir, "deployment-state.json");
const secretsPath = resolve(stateDir, "secrets.json");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function commandVersion(name, argv = ["--version"]) {
  const result = spawnSync(name, argv, { cwd: root, encoding: "utf8", timeout: 8000 });
  if (result.error) return { ok: false, detail: result.error.code ?? result.error.message };
  return { ok: result.status === 0, detail: (result.stdout || result.stderr || "").trim().split("\n")[0] };
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return { name: "Node.js", ok: major >= 24, detail: `${process.versions.node} (requires >=24)` };
}

function checks() {
  const list = [checkNode(), { name: "platform", ok: ["darwin", "linux"].includes(process.platform), detail: `${process.platform}/${process.arch}` }];
  for (const name of ["git", "npx"]) list.push({ name, ...commandVersion(name) });
  const wrangler = commandVersion("npx", ["--no-install", "wrangler", "--version"]);
  list.push({ name: "Wrangler", ok: wrangler.ok, detail: wrangler.ok ? wrangler.detail : "project-local Wrangler will be installed by npm install" });
  const auth = spawnSync("npx", ["--no-install", "wrangler", "whoami"], { cwd: root, encoding: "utf8", timeout: 15000 });
  const authText = `${auth.stdout || ""}\n${auth.stderr || ""}`;
  const authenticated = auth.status === 0 && !/(not logged|not authenticated|no api token|unauthorized)/i.test(authText);
  list.push({ name: "Cloudflare auth", ok: authenticated, detail: authenticated ? authText.trim().split("\n").filter(Boolean).slice(-1)[0] : "not authenticated (run npm exec wrangler login)" });
  return list;
}

function readManifest() {
  const file = resolve(stateDir, "release-manifest.json");
  if (!existsSync(file)) throw new Error(`release manifest is required at ${file}; download a published release before applying`);
  try { return validateManifest(JSON.parse(readFileSync(file, "utf8"))); } catch (error) { throw new Error(`invalid release manifest: ${error.message}`); }
}

function jsonc(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s+|,)\/\/.*$/gm, "$1"));
}

function writeDeploymentConfig(config, image) {
  const source = jsonc(resolve(root, "wrangler.jsonc"));
  const absolute = (value) => typeof value === "string" ? resolve(root, value) : value;
  delete source.$schema;
  source.account_id = cloudflareAccount(config);
  source.vars = { ...source.vars, APP_ACCOUNT_ID: source.account_id, APP_WORKER_NAME: source.name };
  source.main = absolute(source.main);
  if (source.assets?.directory) source.assets.directory = absolute(source.assets.directory);
  if (source.containers?.[0]) {
    source.containers[0].image = image;
    delete source.containers[0].image_build_context;
  }
  const output = resolve(stateDir, "wrangler.deploy.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 }); chmodSync(output, 0o600);
  return output;
}

function readConfig() {
  if (!existsSync(configPath)) return { schemaVersion: 1, name: "ocbot-personal", opencodeVersion: "2.0.11" };
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch (error) { throw new Error(`Invalid deployment config ${configPath}: ${error.message}`); }
}

function validateDeploymentConfig(config) {
  const wrangler = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
  const expectedWorker = config.name ?? "ocbot-personal";
  const expectedBucket = config.bucketName ?? "ocbot-personal-artifacts";
  if (!new RegExp(`"name"\\s*:\\s*"${expectedWorker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(wrangler)) throw new Error(`deployment name ${expectedWorker} does not match wrangler.jsonc`);
  if (!new RegExp(`"bucket_name"\\s*:\\s*"${expectedBucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(wrangler)) throw new Error(`bucketName ${expectedBucket} does not match wrangler.jsonc`);
}

function plan(config) {
  return {
    schemaVersion: 1,
    project: config.name ?? "ocbot-personal",
    runtime: { opencodeVersion: config.opencodeVersion ?? "2.0.11", sandboxPackage: config.sandboxPackage ?? "@cloudflare/sandbox@0.12.9" },
    resources: ["Worker", "Workspace Durable Object", "Sandbox container", "R2 artifact bucket"],
    secrets: ["APP_TOKEN", "RUNNER_TOKEN"],
    mutations: ["install locked dependencies", "build web assets", "create or adopt the project-owned R2 bucket", "deploy Worker", "upload secrets"],
    warnings: ["Workers Paid/Containers eligibility and model provider access are account-specific", "no deployment is performed without --apply", "this tool never purchases a plan or changes unrelated resources"]
  };
}

function printChecks(list) {
  for (const item of list) console.log(`${item.ok ? "ok" : "!!"} ${item.name}: ${item.detail}`);
}

function token() { return randomBytes(32).toString("base64url"); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function writeDevVars() {
  const file = resolve(root, ".dev.vars");
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const content = `APP_TOKEN=${token()}\nRUNNER_TOKEN=${token()}\n`;
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`created ${file} (tokens are local-only and were not printed)`);
  return true;
}

function runRequired(label, name, argv, options = {}) {
  const result = spawnSync(name, argv, { cwd: root, encoding: "utf8", timeout: options.timeout ?? 1200000, maxBuffer: 32 * 1024 * 1024, input: options.input, env: options.env ? { ...process.env, ...options.env } : process.env, stdio: options.inherit ? "inherit" : "pipe" });
  if (result.status !== 0) {
    const detail = options.sensitive ? "" : `${result.stderr || result.stdout || ""}`.trim().split("\n").filter(Boolean).slice(-8).join(" ").slice(0, 1200);
    throw new Error(`${label} failed (exit ${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function bootstrapCrane() {
  const dir = resolve(stateDir, "bin"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binary = resolve(dir, "crane");
  if (existsSync(binary)) return binary;
  const asset = craneAsset();
  const archive = resolve(dir, "crane.tar.gz");
  // Download the pinned official archive, then verify before extraction.
  const response = spawnSync("curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", asset.url, "-o", archive], { cwd: root, encoding: "utf8", timeout: 120000 });
  if (response.status !== 0) throw new Error("crane bootstrap download failed");
  if (verifyArchive(archive, { size: readFileSync(archive).byteLength, sha256: asset.sha256 }).sha256 !== asset.sha256) throw new Error("crane bootstrap checksum mismatch");
  runRequired("crane extraction", "tar", ["-xzf", archive, "-C", dir, "crane"], { timeout: 120000 });
  chmodSync(binary, 0o700);
  return binary;
}

function cloudflareAccount(config) {
  const selected = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  if (selected && config.accountId && selected !== config.accountId) throw new Error("Cloudflare account selection does not match deployment config");
  const account = config.accountId ?? selected;
  if (!/^[a-f0-9]{32}$/i.test(account ?? "")) throw new Error("CLOUDFLARE_ACCOUNT_ID must identify your Cloudflare account");
  return account;
}

function registryCredentials(account) {
  const result = runRequired("registry credentials", "npx", ["--no-install", "wrangler", "containers", "registries", "credentials", "registry.cloudflare.com", "--push", "--pull", "--json", "--expiration-minutes", "60"], { sensitive: true });
  let credentials;
  try { credentials = JSON.parse(result.stdout); } catch { throw new Error("Cloudflare registry credentials response was not valid JSON"); }
  const username = credentials.username ?? credentials.user; const password = credentials.password ?? credentials.token;
  if (!username || !password) throw new Error("Cloudflare registry credentials response was incomplete");
  if (credentials.account_id !== account || credentials.registry_host !== "registry.cloudflare.com") throw new Error("Cloudflare registry credentials do not match the selected account");
  return { username, password };
}

async function publishImage(manifest, config) {
  const account = cloudflareAccount(config);
  const archive = resolve(stateDir, manifest.imageArchive.file);
  if (!existsSync(archive)) throw new Error(`release archive is missing at ${archive}`);
  verifyArchive(archive, manifest.imageArchive);
  const crane = bootstrapCrane();
  const credentials = registryCredentials(account);
  const dockerConfig = resolve(stateDir, `docker-config-${process.pid}`); mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  const unpacked = resolve(stateDir, `computer-image-${process.pid}.tar`);
  try {
    await pipeline(createReadStream(archive), createGunzip(), createWriteStream(unpacked, { mode: 0o600, flags: "wx" }));
    runRequired("registry login", crane, ["auth", "login", "registry.cloudflare.com", "--username", credentials.username, "--password-stdin"], { sensitive: true, input: `${credentials.password}\n`, env: { DOCKER_CONFIG: dockerConfig } });
    const image = `registry.cloudflare.com/${account}/opencode-bot:${manifest.version}-${manifest.commit}`;
    runRequired("image push", crane, ["push", unpacked, image], { timeout: 1800000, env: { DOCKER_CONFIG: dockerConfig } });
    const digestResult = runRequired("image digest", crane, ["digest", image], { env: { DOCKER_CONFIG: dockerConfig } });
    const digest = (digestResult.stdout ?? "").trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("registry returned an invalid image digest");
    return { image: `registry.cloudflare.com/${account}/opencode-bot@${digest}`, digest };
  } finally {
    rmSync(unpacked, { force: true });
    // Keep credentials isolated for the entire operation and remove the temporary config.
    try { runRequired("registry logout", crane, ["auth", "logout", "registry.cloudflare.com"], { timeout: 30000, env: { DOCKER_CONFIG: dockerConfig } }); } catch {}
    try { rmSync(dockerConfig, { recursive: true, force: true }); } catch {}
  }
}

async function applyDaemonless(config) {
  const manifest = readManifest();
  assertSourceCommit(manifest, root);
  const account = cloudflareAccount(config);
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
  if (manifest.opencodeVersion !== (config.opencodeVersion ?? "2.0.11") || `@cloudflare/sandbox@${manifest.sandboxVersion}` !== (config.sandboxPackage ?? "@cloudflare/sandbox@0.12.9")) throw new Error("release runtime versions do not match deployment configuration");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (manifest.schemaVersion === 1) {
    const archive = resolve(stateDir, manifest.imageArchive.file);
    if (!existsSync(archive)) {
      console.log(`Downloading the verified computer image for ${manifest.version}. This may take several minutes.`);
      await downloadReleaseArchive(manifest, archive);
    }
    verifyArchive(archive, manifest.imageArchive);
  }
  validateDeploymentConfig(config);
  const list = checks(); printChecks(list);
  if (list.some((item) => !item.ok && item.name !== "Wrangler")) throw new Error("required prerequisite failed; fix doctor output before applying");
  if (!existsSync(resolve(root, "package.json"))) throw new Error("package.json is missing");
  if (list.some((item) => item.name === "Wrangler" && !item.ok)) {
    if (!install) throw new Error("Wrangler is missing; rerun with --install-missing");
    runRequired("npm ci", "npm", ["ci"], { inherit: true });
  }
  const material = secretMaterial();
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { schemaVersion: 1, project: config.name ?? "ocbot-personal", createdAt: new Date().toISOString(), resources: {}, journal: [] };
  if (state.uninstall && !state.uninstalledAt) throw new Error("Finish the interrupted uninstall before reinstalling.");
  if (state.uninstalledAt) { state.previousUninstalledAt = state.uninstalledAt; delete state.uninstalledAt; delete state.uninstall; state.resources = {}; state.journal = []; delete state.deploymentUrl; }
  ensureWorkerOwnership(config, state);
  state.accountId = account;
  state.workerName = config.name ?? "ocbot-personal";
  state.secretDigests = { APP_TOKEN: digest(material.APP_TOKEN), RUNNER_TOKEN: digest(material.RUNNER_TOKEN) };
  journal(state, "prepare", "started");
  runRequired("npm ci", "npm", ["ci"], { inherit: true }); journal(state, "dependencies", "complete");
  runRequired("web build", "npm", ["run", "build"], { inherit: true }); journal(state, "build", "complete");
  ensureBucket(config, state); journal(state, "r2", "complete");
  let published;
  if (manifest.schemaVersion === 2) {
    published = { image: manifest.image.reference };
    console.log("Cloudflare will pull the released computer image directly from Docker Hub.");
  } else {
    console.log("Uploading the prebuilt computer image to your Cloudflare account. Docker is not required.");
    published = await publishImage(manifest, config);
  }
  const deploymentConfig = writeDeploymentConfig(config, published.image);
  console.log("Deploying the application to Cloudflare.");
  const deployed = runRequired("Worker deploy", "npx", ["--no-install", "wrangler", "deploy", "--config", deploymentConfig]);
  const workerName = config.name ?? "ocbot-personal";
  const appUrl = `${deployed.stdout || ""}\n${deployed.stderr || ""}`.match(/https:\/\/[A-Za-z0-9.-]+\.(?:workers\.dev|pages\.dev)(?:\/[^\s]*)?/i)?.[0]?.replace(/[).,]+$/, "");
  if (!appUrl || !new URL(appUrl).hostname.toLowerCase().startsWith(workerName.toLowerCase() + ".")) throw new Error("Worker deploy returned an unexpected public URL");
  state.deploymentUrl = appUrl; state.resources.worker = appUrl; state.resources.workerName = workerName; state.resources.accountId = account; state.resources.containerApplication = { worker: workerName, className: "Sandbox", managedBy: workerName }; state.resources.image = published.image; journal(state, "deploy", "complete", appUrl);
  runRequired("secret upload", "npx", ["--no-install", "wrangler", "secret", "bulk", secretsPath, "--config", deploymentConfig], { inherit: true }); journal(state, "secrets", "complete");
  state.health = process.env.OCBOT_SKIP_HEALTH === "1" ? { skipped: true } : await verifyDeployment(appUrl, material.APP_TOKEN);
  journal(state, "health", state.health.skipped ? "skipped" : "complete", state.health.skipped ? "test override" : `HTTP ${state.health.status}`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); chmodSync(statePath, 0o600);
  console.log(`Deployment complete: ${appUrl}`);
}

function journal(state, stage, status, detail) {
  state.journal ??= [];
  state.journal.push({ stage, status, ...(detail ? { detail } : {}), at: new Date().toISOString() });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function secretMaterial() {
  const material = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : { APP_TOKEN: token(), RUNNER_TOKEN: token() };
  let changed = false;
  for (const name of ["OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENCODE_API_KEY"]) {
    if (process.env[name] && material[name] !== process.env[name]) { material[name] = process.env[name]; changed = true; }
  }
  if (!existsSync(secretsPath) || changed) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${secretsPath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(material)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, secretsPath);
    chmodSync(secretsPath, 0o600);
  }
  return material;
}

function ensureBucket(config, state) {
  const bucket = config.bucketName ?? "ocbot-personal-artifacts";
  let listed;
  try {
    listed = runRequired("R2 bucket list", "npx", ["--no-install", "wrangler", "r2", "bucket", "list"]);
  } catch (error) {
    if (/10042|enable R2|R2.*dashboard/i.test(error.message)) {
      throw new Error("Cloudflare R2 is not enabled for this account. Enable R2 in the Cloudflare dashboard (https://dash.cloudflare.com/?to=/:account/r2) and rerun the installer; no billing or account changes were made automatically.");
    }
    throw error;
  }
  // Wrangler 4.135 has no --json flag for this command. Match the exact
  // bucket name in its table output while avoiding substring adoption.
  const bucketExists = (listed.stdout || "").split(/\r?\n/).some((line) => {
    const match = line.trim().match(/^name:\s+(\S+)/);
    return match?.[1] === bucket;
  });
  if (bucketExists && !state.resources?.r2) throw new Error(`R2 bucket ${bucket} already exists but is not recorded as owned by this installation; choose a unique bucketName or rerun with the original deployment state`);
  if (!bucketExists) runRequired("R2 bucket create", "npx", ["--no-install", "wrangler", "r2", "bucket", "create", bucket], { inherit: true });
  state.resources.r2 = bucket;
}

function ensureWorkerOwnership(config, state) {
  if (state.resources?.worker || state.deploymentUrl) return;
  const worker = config.name ?? "ocbot-personal";
  let deployments;
  try { deployments = runRequired("Worker deployment lookup", "npx", ["--no-install", "wrangler", "deployments", "list", "--name", worker]); }
  catch (error) {
    if (/10007|not found|does not exist/i.test(error.message)) return;
    throw error;
  }
  if ((deployments.stdout || "").trim()) throw new Error(`Worker ${worker} already has Cloudflare deployment history but this checkout has no ownership state; use the original checkout or choose a unique deployment name`);
}

async function verifyDeployment(url, tokenValue) {
  const endpoint = `${url.replace(/\/$/, "")}/api/state`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(endpoint, { redirect: "error", headers: { Authorization: `Bearer ${tokenValue}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.bots) || !Array.isArray(body.threads) || !Array.isArray(body.runs)) throw new Error("invalid workspace response");
      const unauthenticated = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (unauthenticated.status !== 401) throw new Error("unauthenticated API access was not rejected");
      return { status: response.status, state: true, authentication: true };
    } catch (error) {
      if (attempt === 5) throw new Error(`deployed Worker health check failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function applyDeployment(config) {
  validateDeploymentConfig(config);
  let list = checks();
  printChecks(list);
  const wranglerMissing = list.some((item) => item.name === "Wrangler" && !item.ok);
  const installable = new Set(["Wrangler"]);
  if (wranglerMissing) installable.add("Cloudflare auth");
  const hardFailures = list.filter((item) => !item.ok && !installable.has(item.name));
  if (hardFailures.length) throw new Error("required prerequisite failed; fix doctor output before applying");
  if (!existsSync(resolve(root, "package.json"))) throw new Error("package.json is missing; run npm install after the project manifest is created");
  if (list.some((item) => item.name === "Wrangler" && !item.ok)) {
    if (!install) throw new Error("Wrangler is missing; rerun with --install-missing to install project dependencies");
    runRequired("npm ci", "npm", ["ci"], { inherit: true });
    list = checks();
    printChecks(list);
    if (list.some((item) => !item.ok && ["Wrangler", "Cloudflare auth"].includes(item.name))) throw new Error("Wrangler installation or Cloudflare authentication failed");
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const material = secretMaterial();
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { schemaVersion: 1, project: config.name ?? "ocbot-personal", createdAt: new Date().toISOString(), resources: {}, journal: [] };
  if (state.uninstall && !state.uninstalledAt) throw new Error("Finish the interrupted uninstall before reinstalling.");
  if (state.uninstalledAt) { state.previousUninstalledAt = state.uninstalledAt; delete state.uninstalledAt; delete state.uninstall; state.resources = {}; state.journal = []; delete state.deploymentUrl; }
  ensureWorkerOwnership(config, state);
  state.secretDigests = { APP_TOKEN: digest(material.APP_TOKEN), RUNNER_TOKEN: digest(material.RUNNER_TOKEN) };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
  journal(state, "prepare", "started");
  if (install) writeDevVars();
  // Reconcile dependencies on every apply: the lockfile may have changed
  // since the previous journal entry, and npm ci is deterministic/idempotent.
  runRequired("npm ci", "npm", ["ci"], { inherit: true }); journal(state, "dependencies", "complete");
  runRequired("web build", "npm", ["run", "build"], { inherit: true }); journal(state, "build", "complete");
  ensureBucket(config, state); journal(state, "r2", "complete");
  console.log("Building and publishing the Sandbox image and Worker. The first deployment can take several minutes.");
  const deployed = runRequired("Worker deploy", "npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.jsonc"]);
  const workerName = config.name ?? "ocbot-personal";
  const appUrl = `${deployed.stdout || ""}\n${deployed.stderr || ""}`.match(/https:\/\/[A-Za-z0-9.-]+\.(?:workers\.dev|pages\.dev)(?:\/[^\s]*)?/i)?.[0]?.replace(/[).,]+$/, "");
  if (appUrl && !new URL(appUrl).hostname.toLowerCase().startsWith(workerName.toLowerCase() + ".")) throw new Error("Worker deploy returned an unexpected public URL; refusing to hand off credentials");
  if (!appUrl) throw new Error("Worker deploy completed without a discoverable public URL; inspect Wrangler output and rerun setup");
  state.accountId = cloudflareAccount(config); state.workerName = workerName; state.deploymentUrl = appUrl; state.resources.worker = appUrl; state.resources.workerName = workerName; state.resources.accountId = state.accountId; state.resources.containerApplication = { worker: workerName, className: "Sandbox", managedBy: workerName }; journal(state, "deploy", "complete", appUrl);
  runRequired("secret upload", "npx", ["--no-install", "wrangler", "secret", "bulk", secretsPath, "--config", "wrangler.jsonc"], { inherit: true }); journal(state, "secrets", "complete");
  state.health = process.env.OCBOT_SKIP_HEALTH === "1" ? { skipped: true } : await verifyDeployment(appUrl, material.APP_TOKEN);
  journal(state, "health", state.health.skipped ? "skipped" : "complete", state.health.skipped ? "test override" : `HTTP ${state.health.status}`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); chmodSync(statePath, 0o600);
  console.log(`Deployment complete: ${appUrl}`);
  console.log(`Onboarding handoff is available from ${statePath}; the connection token remains mode-0600 and is never printed.`);
}

async function main() {
  if (args.has("--help") || args.has("-h")) { console.log("Usage: setup.sh [doctor|plan|apply|uninstall] [--config FILE] [--apply] [--install-missing] [--yes] [--keep-artifacts]"); return; }
  const config = readConfig();
  if (command === "doctor") { const result = checks(); printChecks(result); if (result.some((item) => !item.ok)) process.exitCode = 1; return; }
  if (command === "plan" || args.has("--plan")) { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === "uninstall") {
    const ownership = readOwnership({ statePath, config, root });
    const keepData = args.has("--keep-data") || args.has("--keep-artifacts");
    console.log(JSON.stringify(uninstallPlan(ownership, { keepData }), null, 2));
    if (args.has("--yes")) await uninstallResources({ ownership, root, statePath, yes: true, keepData });
    else console.log("Dry run only. No Cloudflare resources were changed. Re-run with `uninstall --yes` to delete the listed resources.");
    return;
  }
  if (command === "apply") {
    if (!apply) throw new Error("apply requires explicit --apply");
    if (args.has("--build-local")) await applyDeployment(config);
    else await applyDaemonless(config);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

try { await main(); } catch (error) { console.error(`setup error: ${error.message}`); process.exitCode = 1; }

export { checkNode, checks, plan, digest, validateDeploymentConfig, writeDeploymentConfig, publishImage, applyDaemonless, readOwnership, uninstallPlan, uninstallResources };
