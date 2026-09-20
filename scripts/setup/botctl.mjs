#!/usr/bin/env node
/**
 * Small, dependency-free installer/doctor for opencode-bot.
 *
 * `plan` and `doctor` are read-only. `apply` is the only command that writes
 * deployment state or invokes Wrangler. Secrets are generated in memory and
 * are never printed or stored in the deployment journal.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

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
  for (const name of ["git", "docker", "npx"]) list.push({ name, ...commandVersion(name) });
  const dockerInfo = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 8000 });
  list.push({ name: "container daemon", ok: dockerInfo.status === 0, detail: dockerInfo.status === 0 ? `Docker ${dockerInfo.stdout.trim()}` : "not reachable (start Docker/compatible daemon)" });
  const wrangler = commandVersion("npx", ["--no-install", "wrangler", "--version"]);
  list.push({ name: "Wrangler", ok: wrangler.ok, detail: wrangler.ok ? wrangler.detail : "project-local Wrangler will be installed by npm install" });
  const auth = spawnSync("npx", ["--no-install", "wrangler", "whoami"], { cwd: root, encoding: "utf8", timeout: 15000 });
  const authText = `${auth.stdout || ""}\n${auth.stderr || ""}`;
  const authenticated = auth.status === 0 && !/(not logged|not authenticated|no api token|unauthorized)/i.test(authText);
  list.push({ name: "Cloudflare auth", ok: authenticated, detail: authenticated ? authText.trim().split("\n").filter(Boolean).slice(-1)[0] : "not authenticated (run npm exec wrangler login)" });
  return list;
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
  const result = spawnSync(name, argv, { cwd: root, encoding: "utf8", timeout: options.timeout ?? 600000, stdio: options.inherit ? "inherit" : "pipe" });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? "unknown"})`);
  return result;
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
  const listed = runRequired("R2 bucket list", "npx", ["--no-install", "wrangler", "r2", "bucket", "list"]);
  // Wrangler 4.135 has no --json flag for this command. Match the exact
  // bucket name in its table output while avoiding substring adoption.
  const bucketExists = (listed.stdout || "").split(/\r?\n/).some((line) => {
    const match = line.trim().match(/^name:\s+(\S+)/);
    return match?.[1] === bucket;
  });
  if (!bucketExists) runRequired("R2 bucket create", "npx", ["--no-install", "wrangler", "r2", "bucket", "create", bucket], { inherit: true });
  state.resources.r2 = bucket;
}

function applyDeployment(config) {
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
  runRequired("Worker deploy", "npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.jsonc"], { inherit: true }); journal(state, "deploy", "complete");
  runRequired("secret upload", "npx", ["--no-install", "wrangler", "secret", "bulk", secretsPath, "--config", "wrangler.jsonc"], { inherit: true }); journal(state, "secrets", "complete");
  console.log("Deployment complete. Secret values were stored only in the mode-0600 local state directory.");
}

function main() {
  if (args.has("--help") || args.has("-h")) { console.log("Usage: setup.sh [doctor|plan|apply] [--config FILE] [--apply] [--install-missing]"); return; }
  const config = readConfig();
  if (command === "doctor") { const result = checks(); printChecks(result); if (result.some((item) => !item.ok)) process.exitCode = 1; return; }
  if (command === "plan" || args.has("--plan")) { console.log(JSON.stringify(plan(config), null, 2)); return; }
  if (command === "apply") {
    if (!apply) throw new Error("apply requires explicit --apply");
    applyDeployment(config);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

try { main(); } catch (error) { console.error(`setup error: ${error.message}`); process.exitCode = 1; }

export { checkNode, checks, plan, digest };
