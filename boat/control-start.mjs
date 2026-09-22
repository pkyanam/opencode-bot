#!/usr/bin/env node
// Boat release entrypoint. Tokens are read from mode-0600 files and never put in
// the systemd unit, command line, or process environment.
import {
  startLocalControl,
  BoatUpdater,
} from "/opt/opencode-bot/releases/current/control-local.js";
import { readFile } from "node:fs/promises";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const number = (name, fallback) => Number(process.env[name] || fallback);
const optionalFile = async (name) => {
  const file = process.env[name];
  if (!file) return undefined;
  try {
    return (await readFile(file, "utf8")).trim() || undefined;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const hindsightToken = await optionalFile("HINDSIGHT_TOKEN_FILE");
const providerText = await optionalFile("HINDSIGHT_LLM_CONFIG_FILE");
const memoryProvider = providerText ? JSON.parse(providerText) : undefined;
if (
  memoryProvider &&
  ["llmBaseUrl", "llmApiKey", "llmModel"].some(
    (key) =>
      typeof memoryProvider[key] !== "string" || !memoryProvider[key].trim(),
  )
)
  throw new Error("Memory provider configuration is incomplete");
const hindsightLlmApiKey = await optionalFile("HINDSIGHT_LLM_API_KEY_FILE");
const release = JSON.parse(
  await readFile(
    "/opt/opencode-bot/releases/current/boat-release.json",
    "utf8",
  ),
);
const boatUpdater = new BoatUpdater({
  statePath:
    process.env.OPENCODE_UPDATE_STATE ||
    "/var/lib/opencode-bot/update/state.json",
  currentRelease: "/opt/opencode-bot/releases/current",
  requestPath: "/var/lib/opencode-bot/update/state.json.request",
  privilegedStart: async () => {
    // The root-owned path unit consumes the atomic request. This works with
    // NoNewPrivileges=true and grants the application no sudo capability.
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => execFile('/bin/systemctl', ['is-active', '--quiet', 'opencode-bot-updater.path'], error => error ? reject(new Error('The update watcher is not running. Rerun the installer to repair it.')) : resolve()));
  },
});
const control = await startLocalControl({
  env: { HOSTING_PROVIDER: "boat", RELEASE_COMMIT: release.commit },
  host: process.env.OPENCODE_HOST || "0.0.0.0",
  port: number("OPENCODE_PORT", 8789),
  databasePath: required("OPENCODE_STATE"),
  objectStorePath: required("OPENCODE_OBJECTS"),
  computerDataDir: required("OPENCODE_COMPUTERS"),
  workspacePath: process.env.WORKSPACE_DIRECTORY ?? "/workspace/shared",
  assetsPath: required("OPENCODE_ASSETS"),
  runnerScript: required("OPENCODE_RUNNER_SCRIPT"),
  appTokenFile: required("OPENCODE_APP_TOKEN_FILE"),
  runnerTokenFile: required("OPENCODE_RUNNER_TOKEN_FILE"),
  ...(hindsightToken ? { hindsightToken } : {}),
  ...(hindsightLlmApiKey ? { hindsightLlmApiKey } : {}),
  ...(process.env.HINDSIGHT_BASE_URL
    ? { hindsightBaseUrl: process.env.HINDSIGHT_BASE_URL }
    : {}),
  ...(process.env.HINDSIGHT_LLM_BASE_URL
    ? { hindsightLlmBaseUrl: process.env.HINDSIGHT_LLM_BASE_URL }
    : {}),
  ...(process.env.HINDSIGHT_LLM_MODEL
    ? { hindsightLlmModel: process.env.HINDSIGHT_LLM_MODEL }
    : {}),
  ...(memoryProvider
    ? {
        hindsightLlmBaseUrl: memoryProvider.llmBaseUrl,
        hindsightLlmApiKey: memoryProvider.llmApiKey,
        hindsightLlmModel: memoryProvider.llmModel,
      }
    : {}),
  ...(boatUpdater ? { boatUpdater } : {}),
});
console.log(`opencode-bot control listening on ${control.port()}`);
const shutdown = async () => {
  await control.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
