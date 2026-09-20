#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  cp,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  markerForCheckpoint,
  parseAppToken,
  plannedRestartDecision,
  projectContainerPrefix,
} from "./preview-lifecycle.mjs";

// Keep the container gateway stable while Vite hot-reloads the web client.
// Wrangler source reloads can invalidate the local container egress gateway.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, ".tmp", "stable-preview");
await mkdir(staging, { recursive: true });
const wrangler = path.join(
  root,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const projectName = configProjectName(
  await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
);
const appToken = await resolveAppToken(process.argv.slice(2), root);
const containerPrefix = projectContainerPrefix(projectName);
const restartMarker = path.join(staging, "planned-restart.json");

const retained = await runningProjectContainers(containerPrefix);
if (retained.length) {
  let reachable = false;
  try {
    const response = await fetch("http://127.0.0.1:8789/api/computer/status", {
      headers: appToken ? { authorization: `Bearer ${appToken}` } : {},
      signal: AbortSignal.timeout(1_500),
    });
    reachable = response.ok || response.status === 401;
  } catch {
    /* no current preview process */
  }
  throw new Error(
    `Refusing to start over retained ${projectName} container(s): ${retained.join(", ")}. ${reachable ? "Stop the existing preview with Ctrl-C first." : "The previous preview is unavailable; checkpoint/restore or stop these exact containers before retrying."}`,
  );
}
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`Wrangler exited ${code}`)),
    );
  });
}
await execute([
  "deploy",
  "--dry-run",
  "--outdir",
  path.join(staging, "worker"),
]);
await cp(path.join(root, "apps/web/dist"), path.join(staging, "assets"), {
  recursive: true,
});
const config = JSON.parse(
  await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
);
config.main = path.join(staging, "worker", "index.js");
config.assets.directory = path.join(staging, "assets");
for (const computer of config.containers ?? []) {
  computer.image = path.resolve(root, computer.image);
  computer.image_build_context = root;
}
const filename = path.join(staging, "wrangler.json");
await writeFile(filename, JSON.stringify(config, null, 2));
console.log(
  "Starting stable preview backend. Web changes still refresh through Vite. Restart this command to load backend changes.",
);
const child = spawn(
  process.execPath,
  [
    wrangler,
    "dev",
    "--local",
    "--no-bundle",
    "--config",
    filename,
    "--persist-to",
    path.join(root, ".wrangler/state"),
    "--port",
    "8789",
    ...process.argv.slice(2),
  ],
  // Keep Wrangler/workerd in one process group. Docker-managed Sandbox/proxy
  // containers are stopped explicitly after a successful checkpoint below.
  // The durable state directory remains untouched, so DO/R2 data survives.
  { cwd: root, stdio: "inherit", detached: process.platform !== "win32" },
);
let stopping = false;
async function stopChild(signal) {
  if (stopping) return;
  stopping = true;
  const checkpoint = await requestCheckpoint(appToken);
  if (!checkpoint.ok) {
    console.error(`Preview shutdown refused: ${checkpoint.reason}`);
    stopping = false;
    return;
  }
  try {
    await writeMarker(checkpoint.body);
  } catch (error) {
    console.error(
      `Preview shutdown refused: could not persist restart marker (${error.message}). Data was left running.`,
    );
    stopping = false;
    return;
  }
  try {
    await stopProjectContainers(containerPrefix);
  } catch (error) {
    console.error(
      `Preview shutdown refused: could not stop task-owned containers (${error.message}). Data was left running.`,
    );
    stopping = false;
    return;
  }
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
  // Wrangler may be waiting on a child that ignored the first signal. Force
  // the whole group down after a bounded grace period so the next invocation
  // never reuses a stale workerd/proxy forwarder.
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, 10_000).unref();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void stopChild(signal);
  });
child.once("exit", (code) => {
  process.exitCode = code ?? 0;
});
void recoverPlannedRestart().catch((error) => {
  console.error(`Planned restore could not finish: ${error.message}. The checkpoint marker is retained for recovery.`);
});

function configProjectName(source) {
  const match = source.match(/"name"\s*:\s*"([^"\n]+)"/);
  if (!match || !/^[a-z0-9_-]+$/i.test(match[1]))
    throw new Error("Could not safely determine Wrangler project name");
  return match[1];
}

async function resolveAppToken(args, cwd) {
  if (process.env.APP_TOKEN) return process.env.APP_TOKEN;
  let vars = "";
  try {
    vars = await readFile(path.join(cwd, ".dev.vars"), "utf8");
  } catch {
    /* CLI/env may still provide it. */
  }
  return parseAppToken(args, process.env, vars);
}

function runDocker(args) {
  return new Promise((resolve, reject) =>
    execFile(
      "docker",
      args,
      { cwd: root, encoding: "utf8" },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(error, { stdout, stderr }))
          : resolve({ stdout, stderr }),
    ),
  );
}

async function runningProjectContainers(prefix) {
  try {
    const { stdout } = await runDocker(["ps", "--format", "{{.Names}}"]);
    return stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

async function stopProjectContainers(prefix) {
  const containers = await runningProjectContainers(prefix);
  if (!containers.length) return;
  await runDocker(["stop", "--time", "10", ...containers]);
}

async function requestCheckpoint(token) {
  if (!token)
    return {
      ok: false,
      reason:
        "APP_TOKEN is unavailable; set APP_TOKEN or pass --var APP_TOKEN:<value> so the runner can be checkpointed safely.",
    };
  try {
    const response = await fetch(
      "http://127.0.0.1:8789/api/computer/checkpoint",
      { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) },
    );
    if (response.ok) return { ok: true, body: await response.json() };
    const body = await response.text();
    return {
      ok: false,
      reason: `checkpoint returned HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
    };
  } catch (error) {
    return { ok: false, reason: `checkpoint request failed: ${error.message}` };
  }
}

async function writeMarker(response) {
  const marker = markerForCheckpoint(response);
  const temporary = `${restartMarker}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(marker), { mode: 0o600 });
  await rename(temporary, restartMarker);
}

async function recoverPlannedRestart() {
  let marker;
  try {
    marker = JSON.parse(await readFile(restartMarker, "utf8"));
  } catch {
    return;
  }
  if (!appToken) {
    console.error(
      "Planned restart marker found, but APP_TOKEN is unavailable; restore the committed checkpoint manually.",
    );
    return;
  }
  const status = await waitForComputerStatus(appToken);
  if (!status) return;
  const decision = plannedRestartDecision({
    markerId: marker.checkpointId,
    checkpointId: status.checkpoint?.id,
    readiness: status.readiness,
  });
  if (decision.action === "manual") {
    console.error(
      `Planned restart requires manual restore: ${decision.reason}.`,
    );
    return;
  }
  if (decision.action === "none") return;
  if (decision.action === "clear") {
    await unlink(restartMarker).catch(() => undefined);
    return;
  }
  const response = await fetch("http://127.0.0.1:8789/api/computer/restore", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    console.error(
      `Automatic planned restore failed (HTTP ${response.status}); restore the committed checkpoint manually.`,
    );
    return;
  }
  await unlink(restartMarker).catch(() => undefined);
  console.log("Planned restart checkpoint restored.");
}

async function waitForComputerStatus(token) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        "http://127.0.0.1:8789/api/computer/status",
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (response.ok) return await response.json();
    } catch {
      /* Wrangler is still booting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(
    "Planned restart marker was retained because the preview status endpoint did not become ready.",
  );
  return undefined;
}
