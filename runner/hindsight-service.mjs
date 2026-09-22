import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TARGET = "http://127.0.0.1:8888";
const DEFAULT_PORT = 8790;
const MAX_BODY = 32 * 1024;

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(req, token) {
  return typeof token === "string" && token.length > 0 && req.headers.authorization === `Bearer ${token}`;
}

// Node's fetch transparently decodes compressed upstream bodies.  Forwarding
// the original content-encoding/content-length would make clients attempt to
// decode an already-decoded body (and can truncate it at the stale length).
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length",
]);

function proxyResponseHeaders(headers) {
  return Object.fromEntries([...headers].filter(([name]) => !HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())));
}

export function createHindsightSupervisor(options = {}) {
  const token = options.token ?? process.env.RUNNER_TOKEN;
  const port = Number(options.port ?? process.env.HINDSIGHT_SERVICE_PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.HINDSIGHT_SERVICE_HOST ?? "0.0.0.0";
  const target = options.target ?? process.env.HINDSIGHT_API_URL ?? DEFAULT_TARGET;
  const configuredInstanceId = options.instanceId ?? process.env.HINDSIGHT_INSTANCE_ID;
  let instanceId = configuredInstanceId ?? randomUUID();
  const configPath = options.configPath ?? "/workspace/state/hindsight-config.json";
  const launcher = process.env.HINDSIGHT_PG0_LAUNCHER ?? "hindsight-api";
  const command = options.command ?? (process.env.HINDSIGHT_RUN_AS_USER ? "runuser" : launcher);
  const launched = launcher === "hindsight-api" ? [] : [launcher];
  const commandArgs = options.commandArgs ?? (process.env.HINDSIGHT_RUN_AS_USER ? ["-u", process.env.HINDSIGHT_RUN_AS_USER, "--", ...launched] : launched);
  let child;
  let config;
  let starting;

  async function loadConfig() {
    try { config = JSON.parse(await fs.readFile(configPath, "utf8")); } catch { config = undefined; }
  }
  function publicState() {
    return { instanceId, configured: Boolean(config), running: Boolean(child && child.exitCode === null) };
  }
  async function persist(next) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(next), { mode: 0o600 });
    config = next;
  }
  async function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(() => { child?.kill("SIGKILL"); resolve(); }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    child = undefined;
  }
  async function start() {
    if (!config) return;
    if (starting) return starting;
    starting = (async () => {
      await stop();
      if (!configuredInstanceId) instanceId = randomUUID();
      const env = {
        ...process.env,
        HINDSIGHT_API_LLM_PROVIDER: "openai",
        HINDSIGHT_API_DATABASE_URL: process.env.HINDSIGHT_API_DATABASE_URL ?? "pg0",
        HINDSIGHT_API_LLM_BASE_URL: config.llmBaseUrl,
        HINDSIGHT_API_LLM_API_KEY: config.llmApiKey,
        HINDSIGHT_API_LLM_MODEL: config.llmModel,
        HINDSIGHT_API_EMBEDDINGS_PROVIDER: "onnx",
        HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH: process.env.HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH ?? "/opt/huggingface/intfloat-multilingual-e5-small/onnx/model.onnx",
        HINDSIGHT_API_RERANKER_PROVIDER: "flashrank",
        HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH: process.env.HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH ?? "/opt/huggingface/intfloat-multilingual-e5-small",
        HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR: "/opt/flashrank",
        HINDSIGHT_API_HOST: "127.0.0.1",
        HINDSIGHT_API_PORT: "8888",
      };
      child = spawn(command, commandArgs, { env, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", (error) => { child = undefined; console.error(`hindsight spawn failed: ${error.message}`); });
      child.once("exit", () => { child = undefined; });
    })().finally(() => { starting = undefined; });
    return starting;
  }
  async function handler(req, res) {
    if (req.method === "GET" && req.url === "/live") return json(res, 200, { service: "hindsight-supervisor" });
    if (!authorized(req, token)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/health") {
      let upstream = false;
      if (child && child.exitCode === null) {
        try { upstream = (await fetch(new URL("/health", target), { signal: AbortSignal.timeout(3_000) })).ok; } catch { /* startup is still in progress */ }
      }
      return json(res, upstream ? 200 : 503, { ...publicState(), upstreamReady: upstream });
    }
    if (req.method === "POST" && req.url === "/configure") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (error) { return json(res, error.statusCode ?? 400, { error: "invalid configuration" }); }
      const fields = ["llmBaseUrl", "llmApiKey", "llmModel"];
      if (fields.some(key => typeof body?.[key] !== "string" || !body[key].trim())) return json(res, 400, { error: "llmBaseUrl, llmApiKey, and llmModel are required" });
      if (!/^https?:\/\//i.test(body.llmBaseUrl)) return json(res, 400, { error: "llmBaseUrl must be http(s)" });
      const next = { llmBaseUrl: body.llmBaseUrl, llmApiKey: body.llmApiKey, llmModel: body.llmModel };
      const changed = JSON.stringify(next) !== JSON.stringify(config);
      if (changed) await persist(next);
      if (changed || !child || child.exitCode !== null) await start();
      return json(res, 200, { ...publicState(), changed });
    }
    if (!req.url?.startsWith("/v1/")) return json(res, 404, { error: "not found" });
    if (!config || !child) return json(res, 503, { error: "memory service is not configured" });
    const streaming = !["GET", "HEAD"].includes(req.method);
    const upstream = await fetch(new URL(req.url, target), { method: req.method, headers: req.headers, body: streaming ? req : undefined, ...(streaming ? { duplex: "half" } : {}), signal: AbortSignal.timeout(120_000) });
    res.writeHead(upstream.status, proxyResponseHeaders(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  return { async listen() { await loadConfig(); await start(); return new Promise(resolve => { const server = http.createServer((req, res) => handler(req, res).catch(error => json(res, 502, { error: error.message }))); server.listen(port, host, resolve); }); }, handler, start, stop, state: publicState };
}

if (process.argv[1]?.endsWith("hindsight-service.mjs")) {
  if (!process.env.RUNNER_TOKEN) throw new Error("RUNNER_TOKEN is required");
  const supervisor = createHindsightSupervisor();
  await supervisor.listen();
}
