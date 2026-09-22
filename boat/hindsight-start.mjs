#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHindsightSupervisor } from "/opt/opencode-bot/releases/current/runner/hindsight-service.mjs";

const requiredFile = async (name) => {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is required`);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
};
const configPath = process.env.HINDSIGHT_CONFIG_PATH ?? "/var/lib/opencode-bot/hindsight/config.json";
const token = await requiredFile("HINDSIGHT_TOKEN_FILE");
await mkdir(configPath.slice(0, configPath.lastIndexOf("/")), { recursive: true, mode: 0o700 });
const source = process.env.HINDSIGHT_LLM_CONFIG_FILE;
let provider;
if (source) {
  try { provider = JSON.parse(await readFile(source, "utf8")); } catch { throw new Error("HINDSIGHT_LLM_CONFIG_FILE is not valid JSON"); }
} else if (process.env.HINDSIGHT_LLM_BASE_URL || process.env.HINDSIGHT_LLM_API_KEY || process.env.HINDSIGHT_LLM_MODEL) {
  provider = { llmBaseUrl: process.env.HINDSIGHT_LLM_BASE_URL, llmApiKey: process.env.HINDSIGHT_LLM_API_KEY, llmModel: process.env.HINDSIGHT_LLM_MODEL };
}
if (provider) {
  if ([provider.llmBaseUrl, provider.llmApiKey, provider.llmModel].some(value => typeof value !== "string" || !value.trim())) throw new Error("Hindsight LLM configuration requires llmBaseUrl, llmApiKey, and llmModel");
  if (!/^https?:\/\//i.test(provider.llmBaseUrl)) throw new Error("Hindsight LLM base URL must use http(s)");
  await writeFile(configPath, JSON.stringify({ llmBaseUrl: provider.llmBaseUrl, llmApiKey: provider.llmApiKey, llmModel: provider.llmModel }), { mode: 0o600 });
  await chmod(configPath, 0o600);
}
const supervisor = createHindsightSupervisor({
  token,
  host: "127.0.0.1",
  port: Number(process.env.HINDSIGHT_SERVICE_PORT ?? 8790),
  target: "http://127.0.0.1:8888",
  configPath,
  command: "/opt/opencode-bot/hindsight-venv/bin/python",
  commandArgs: ["/opt/opencode-bot/releases/current/runner/hindsight-launcher.py"],
});
await supervisor.listen();
console.log("local Hindsight supervisor listening on loopback");
const stop = async () => { await supervisor.stop(); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
