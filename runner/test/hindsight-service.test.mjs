import test from "node:test";
import assert from "node:assert/strict";
import { createHindsightSupervisor, HINDSIGHT_DEFAULT_TIMEOUT_MS, HINDSIGHT_REFLECT_TIMEOUT_MS, upstreamTimeoutMs } from "../hindsight-service.mjs";

function request(method, url, body, token = "secret") {
  return { method, url, headers: { authorization: `Bearer ${token}` }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
}
function response() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = value ?? ""; } };
}

test("hindsight supervisor requires the runner token", async () => {
  const service = createHindsightSupervisor({ token: "secret", command: process.execPath, configPath: "/tmp/hindsight-test-missing-config.json" });
  const res = response();
  await service.handler(request("GET", "/health", undefined, "wrong"), res);
  assert.equal(res.status, 401);
});

test("health does not disclose configured credentials", async () => {
  const service = createHindsightSupervisor({ token: "secret", command: process.execPath, configPath: "/tmp/hindsight-test-missing-config.json" });
  const res = response();
  await service.handler(request("GET", "/health"), res);
  assert.equal(res.status, 503);
  assert.doesNotMatch(String(res.body), /secret|apiKey|llmBaseUrl/);
});

test("configure validates and returns only public state", async () => {
  const service = createHindsightSupervisor({ token: "secret", command: process.execPath, configPath: `/tmp/hindsight-test-config-${process.pid}.json` });
  const bad = response();
  await service.handler(request("POST", "/configure", { llmBaseUrl: "file:///tmp", llmApiKey: "key", llmModel: "model" }), bad);
  assert.equal(bad.status, 400);
  const good = response();
  await service.handler(request("POST", "/configure", { llmBaseUrl: "https://workers-ai.invalid/v1", llmApiKey: "key", llmModel: "model" }), good);
  assert.equal(good.status, 200);
  const value = JSON.parse(good.body);
  assert.equal(value.configured, true);
  assert.equal(value.running, true);
  assert.equal(value.changed, true);
  assert.match(value.instanceId, /^[0-9a-f-]{36}$/);
});

test("reflect proxy gets the engine deadline plus a margin", () => {
  assert.equal(upstreamTimeoutMs("/v1/default/banks/bot/reflect"), HINDSIGHT_REFLECT_TIMEOUT_MS);
  assert.ok(HINDSIGHT_REFLECT_TIMEOUT_MS > 300_000);
  assert.equal(upstreamTimeoutMs("/v1/default/banks/bot/memories/recall"), HINDSIGHT_DEFAULT_TIMEOUT_MS);
});
