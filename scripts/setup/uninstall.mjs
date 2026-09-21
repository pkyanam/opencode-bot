/**
 * Safe, resumable cleanup for resources recorded by botctl.
 * The default mode is read-only planning. Cloudflare mutations require --yes.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";

const NOT_FOUND = /(404|not found|does not exist|no such|10007|10042)/i;

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function commandError(label, result) {
  const output = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
  return new Error(`${label} failed${output ? `: ${output.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 900)}` : ""}`);
}

export function readOwnership({ statePath, config, root = process.cwd(), runner = defaultRunner }) {
  if (!existsSync(statePath)) throw new Error(`installation state is missing at ${statePath}; refusing to guess resource ownership`);
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch (error) { throw new Error(`invalid installation state: ${error.message}`); }
  const resources = state.resources ?? {};
  const workerName = resources.workerName ?? state.workerName ?? config.name;
  const bucketName = resources.r2 ?? resources.bucketName;
  if (!state.project || !workerName || !bucketName) throw new Error("installation state has no complete ownership record; refusing to delete resources");
  if (config.name && config.name !== workerName) throw new Error(`deployment config worker ${config.name} does not match owned worker ${workerName}`);
  if (config.bucketName && config.bucketName !== bucketName) throw new Error(`deployment config bucket ${config.bucketName} does not match owned bucket ${bucketName}`);
  const workerUrl = resources.worker ?? state.deploymentUrl;
  if (resources.worker && state.deploymentUrl && resources.worker !== state.deploymentUrl) throw new Error("installation state contains conflicting Worker URLs; refusing to delete");
  if (workerUrl) {
    let host;
    try { host = new URL(workerUrl).hostname.toLowerCase(); } catch { throw new Error("installation state has an invalid Worker URL; refusing to delete"); }
    if (!host.startsWith(`${workerName.toLowerCase()}.`) || !host.endsWith(".workers.dev")) throw new Error(`owned Worker URL ${workerUrl} does not exactly match the recorded ${workerName} workers.dev deployment`);
  }
  let accountId = resources.accountId ?? state.accountId ?? config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  if (!accountId) {
    const whoami = runner("npx", ["--no-install", "wrangler", "whoami", "--json"], { root, env: {} });
    if (whoami.status === 0) {
      try {
        const body = JSON.parse(whoami.stdout ?? "{}");
        const accounts = (body.accounts ?? body.memberships ?? []).map((item) => item.id ?? item.account?.id).filter((id) => /^[a-f0-9]{32}$/i.test(id ?? ""));
        if (accounts.length === 1) accountId = accounts[0];
      } catch {}
    }
  }
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "")) throw new Error("Cloudflare account identity is missing from installation state/config; refusing to delete");
  if (config.accountId && config.accountId !== accountId) throw new Error(`deployment config account ${config.accountId} does not match owned account ${accountId}`);
  const selectedAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  if (selectedAccount && selectedAccount !== accountId) throw new Error(`selected Cloudflare account ${selectedAccount} does not match owned account ${accountId}`);
  if (state.uninstalledAt) return { state, resources, workerName, bucketName, accountId, alreadyUninstalled: true };
  return { state, resources, workerName, bucketName, accountId, workerOwned: Boolean(workerUrl), alreadyUninstalled: false };
}

export function uninstallPlan(ownership, { keepData = false } = {}) {
  const { workerName, bucketName, accountId, resources, workerOwned = Boolean(resources.worker), alreadyUninstalled } = ownership;
  return {
    action: alreadyUninstalled ? "already-uninstalled" : "uninstall",
    accountId,
    resources: [
      { kind: "container application", identity: resources.containerApplication ?? { worker: workerName, className: "Sandbox", managedBy: workerName }, action: "verify Worker namespace ownership, then delete container application" },
      { kind: "Worker and Durable Objects", identity: workerName, action: workerOwned ? "delete Worker (DO namespaces are owned by this Worker)" : "skip (Worker was not recorded as created by this installation)" },
      { kind: "R2 artifact bucket", identity: bucketName, action: keepData ? "keep bucket and all objects (--keep-data)" : "delete every object, then delete bucket" }
    ],
    mutations: alreadyUninstalled ? [] : ["delete installation-owned container application/Worker", ...(keepData ? [] : ["delete installation-owned R2 objects", "delete installation-owned R2 bucket"]), "mark uninstall complete in local state"],
    warnings: ["only exact identities recorded in deployment-state.json are eligible", "404/not-found responses are treated as already absent", "local secrets and the deployment journal are retained"]
  };
}

export async function uninstallResources({ ownership, root, statePath, yes = false, keepData = false, runner = defaultRunner, apiRequest = defaultApiRequest, log = console.log }) {
  if (!yes) throw new Error("uninstall is destructive; rerun with `uninstall --yes` after reviewing the plan");
  if (ownership.alreadyUninstalled) { log("Uninstall already complete; no cloud mutations needed."); return; }
  const { state, workerName, bucketName, accountId, resources, workerOwned = Boolean(resources.worker) } = ownership;
  const ctx = { root, accountId, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
  // Resolve auth before any destructive stage, so an R2 auth failure cannot
  // leave the Worker deleted while its artifacts remain untouched.
  let apiToken;
  {
    apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
    if (!apiToken) {
      const auth = runner("npx", ["--no-install", "wrangler", "auth", "token", "--json"], ctx);
      if (auth.status !== 0) throw new Error("Wrangler authentication failed. Run npx wrangler login and retry.");
      try { apiToken = JSON.parse(auth.stdout ?? "{}").token; } catch { throw new Error("Wrangler auth token returned invalid JSON; refusing R2 cleanup"); }
      if (typeof apiToken !== "string" || !apiToken) throw new Error("Wrangler auth token did not contain a token; refusing R2 cleanup");
    }
  }
  state.uninstall ??= { stages: {} };
  state.uninstall.stages ??= {};
  const save = () => { writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); chmodSync(statePath, 0o600); };
  const stage = (name) => state.uninstall.stages[name] === "complete";
  const complete = (name) => { state.uninstall.stages[name] = "complete"; save(); };
  const invoke = (label, args) => {
    const result = runner("npx", ["--no-install", "wrangler", ...args], ctx);
    if (result.status !== 0) {
      const error = commandError(label, result);
      if (NOT_FOUND.test(error.message)) { log(`${label}: already absent`); return; }
      throw error;
    }
    return result;
  };

  // Confirm the container's namespace belongs to the exact recorded Worker.
  // Persist IDs before deleting anything so interrupted cleanup can resume.
  if (!state.uninstall.verified) {
    const settingsResponse = await apiRequest(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`, {}, "GET", apiToken);
    const settings = settingsResponse.result ?? settingsResponse;
    const bindings = settings.bindings ?? [];
    const artifactBinding = bindings.find(item => item.type === "r2_bucket" && item.name === "ARTIFACTS");
    if (artifactBinding && artifactBinding.bucket_name !== bucketName) throw new Error("Live Worker artifact bucket differs from the installation record; refusing cleanup");
    const namespaces = bindings.filter(item => item.type === "durable_object_namespace" && !item.script_name).map(item => item.namespace_id).filter(Boolean);
    const appsResponse = await apiRequest(`/accounts/${accountId}/containers/applications`, {}, "GET", apiToken);
    const apps = appsResponse.result ?? appsResponse;
    if (!Array.isArray(apps)) throw new Error("Could not verify container ownership");
    const owned = apps.filter(app => namespaces.includes(app.durable_objects?.namespace_id));
    if (!namespaces.length && apps.some(app => app.name === `${workerName}-sandbox`)) throw new Error("Container remains but Worker namespace ownership could not be verified; refusing to guess");
    state.uninstall.containers = owned.map(app => ({id:app.id,name:app.name}));
    state.uninstall.namespaceIds = namespaces;
    state.uninstall.verified = true;
    save();
  }
  if (!stage("container")) {
    for (const app of state.uninstall.containers ?? []) {
      if (!/^[a-f0-9-]{36}$/i.test(app.id)) throw new Error("Invalid recorded container ID");
      await apiRequest(`/accounts/${accountId}/containers/applications/${app.id}`, {}, "DELETE", apiToken);
      log(`Deleted container application ${app.name}`);
    }
    complete("container");
  }
  if (!stage("worker") && workerOwned) {
    invoke("Worker deletion", ["delete", "--name", workerName, "--force"]);
    complete("worker");
  } else if (!workerOwned) {
    log(`Worker ${workerName}: not recorded as created by this installation; skipping`);
    complete("worker");
  }
  if (!keepData && !stage("r2")) {
    let cursor;
    const objects = [];
    do {
      const listed = await apiRequest(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects`, { cursor, per_page: "1000" }, "GET", apiToken);
      const result = listed.result ?? listed;
      const page = Array.isArray(result) ? result : result?.objects;
      if (!Array.isArray(page)) throw new Error("Cloudflare R2 object listing had an unexpected shape; refusing to delete the bucket");
      for (const object of page) objects.push(object);
      const next = listed.result_info?.cursor ?? result.cursor ?? listed.cursor ?? undefined;
      if (next && next === cursor) throw new Error("R2 listing repeated its cursor; refusing incomplete cleanup");
      cursor = next;
    } while (cursor);
    for (const object of objects) {
      const key = typeof object === "string" ? object : object?.key;
      if (!key || typeof key !== "string") throw new Error("R2 object list contained an item without an exact key; refusing to continue");
      const keyStage = `r2:${Buffer.from(key).toString("base64url")}`;
      if (stage(keyStage)) continue;
      try {
        await apiRequest(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(key)}`, undefined, "DELETE", apiToken);
      } catch (error) {
        if (!NOT_FOUND.test(error.message ?? "")) throw error;
        log(`R2 object ${key}: already absent`);
      }
      complete(keyStage);
    }
    invoke("R2 bucket deletion", ["r2", "bucket", "delete", bucketName]);
    complete("r2");
  } else if (keepData) {
    log(`keeping R2 bucket ${bucketName} and its contents (--keep-data)`);
    complete("r2-kept");
  }
  state.uninstalledAt = new Date().toISOString();
  state.uninstall.accountId = accountId;
  save();
  log("Uninstall complete. Local deployment state and secrets were retained.");
}

function defaultRunner(name, args, options) { return spawnSync(name, args, { cwd: options.root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...options.env } }); }

async function defaultApiRequest(path, query = {}, method = "GET", token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN) {
  const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
  for (const [key, value] of Object.entries(query ?? {})) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 404) return { result: [], result_info: {} };
    throw new Error(`Cloudflare R2 API ${method} ${path} failed (${response.status}): ${body.slice(0, 500)}`);
  }
  if (!body.trim()) return {success:true};
  const parsed = parseJson(body, "Cloudflare API");
  if (parsed.success === false) throw new Error(`Cloudflare API rejected ${method} ${path}`);
  return parsed;
}
