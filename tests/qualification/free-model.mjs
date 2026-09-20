#!/usr/bin/env node
/**
 * Qualify OpenCode Zen's currently advertised free model without importing
 * credentials from the operator machine. This intentionally records a
 * blocked result when Zen's account/anti-abuse gate rejects an unauthenticated
 * request; it never substitutes a fake model response.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OpenCode } from "../../node_modules/@opencode/client/dist/promise/client.js";
import * as ServiceModule from "@opencode/client/service";

const cli = process.env.OPENCODE2_BIN || "opencode2";
const expected = process.env.OPENCODE2_VERSION || "2.0.11";
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
if (!version.endsWith(`v${expected}`)) throw new Error(`requires OpenCode ${expected}; got ${version}`);

const root = await mkdtemp(path.join(os.tmpdir(), "opencode2-free-model-"));
const configHome = path.join(root, "config");
const stateHome = path.join(root, "state");
const dataHome = path.join(root, "data");
const workspace = path.join(root, "workspace");
const serviceFile = path.join(stateHome, "opencode", "service.json");
await mkdir(path.join(configHome, "opencode"), { recursive: true });
await mkdir(workspace, { recursive: true });

const config = {
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "deny" },
    { "action": "edit", "resource": "*", "effect": "deny" }
  ]
};
await writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 });

const credentialPattern = /(API_KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;
const scrubbedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !credentialPattern.test(key)));
const env = {
  ...scrubbedEnv,
  HOME: root,
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  XDG_DATA_HOME: dataHome,
  OPENCODE_DIRECTORY: workspace,
  NO_PROXY: [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(","),
};
const Service = ServiceModule.Service ?? ServiceModule;
let endpoint;
let client;
let result = { cli: version, expected, serviceFile, modelEndpoint: "https://opencode.ai/zen/v1", model: "big-pickle" };
try {
  const zenCatalogResponse = await fetch("https://opencode.ai/zen/v1/models");
  const zenCatalog = await zenCatalogResponse.json();
  result.zenCatalog = {
    status: zenCatalogResponse.status,
    freeModels: (zenCatalog.data ?? []).map((entry) => entry.id).filter((id) => /free|pickle/i.test(String(id))),
  };
  endpoint = await Service.ensure({
    file: serviceFile,
    version: expected,
    command: [cli, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"],
    env,
  });
  const headers = Service.headers(endpoint) ?? {};
  client = OpenCode.make({ baseUrl: endpoint.url, headers, throwOnError: true });
  const info = await client.server.info();
  const location = { location: { directory: workspace } };
  const providers = await client.provider.list(location);
  const catalog = await client.model.list(location);
  const plugins = await client.plugin.list(location);
  const loadedConfig = await client.config.get(location);
  const models = catalog?.data ?? catalog;
  const catalogIds = Array.isArray(models) ? models.map((entry) => entry.id ?? entry.modelID ?? entry.modelId).filter(Boolean) : [];
  result.serverVersion = info.version;
  result.providers = (providers?.data ?? []).map((entry) => ({ id: entry.id, activation: entry.activation, package: entry.package }));
  result.plugins = (plugins?.data ?? []).map((entry) => ({ id: entry.id, name: entry.name, status: entry.status }));
  result.configDocuments = loadedConfig.length;
  result.catalogShape = Array.isArray(models) ? "array" : typeof models;
  result.catalogContainsBigPickle = catalogIds.some((id) => String(id).endsWith("/big-pickle") || id === "big-pickle");
  result.catalogSample = catalogIds.slice(0, 20);
  assert.match(String(info.version), /^2\./);
  const session = await client.session.create({ location: { directory: workspace }, model: { providerID: "opencode", id: "big-pickle" } });
  result.sessionID = session.id;
  try {
    await client.session.prompt({ sessionID: session.id, text: "Reply with exactly FREE_MODEL_OK" });
    await client.session.wait({ sessionID: session.id });
    const messages = await client.message.list({ sessionID: session.id });
    result.messageSummary = summarizeMessages(messages);
    result.response = extractAssistantText(messages);
    const assistantError = (messages?.data ?? messages)?.find?.((message) => message.type === "assistant" && message.error)?.error;
    result.status = assistantError ? "blocked" : result.response ? "completed" : "no_assistant_response";
    if (assistantError) result.executionError = assistantError;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "blocked";
    result.error = serializeError(error);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  if (endpoint) await Service.stop({ file: serviceFile }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function extractAssistantText(value) {
  const messages = value?.data ?? value;
  if (!Array.isArray(messages)) return "";
  return messages.filter((message) => message.type === "assistant").flatMap((message) => message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function summarizeMessages(value) {
  const messages = value?.data ?? value;
  if (!Array.isArray(messages)) return { shape: typeof messages };
  return messages.map((message) => ({ id: message.id, type: message.type, error: message.error, contentTypes: (message.content ?? []).map((part) => part.type) }));
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    statusCode: error?.statusCode,
    responseBody: error?.responseBody,
    data: error?.data,
  };
}
