import test from "node:test";
import assert from "node:assert/strict";
import { createSelfContext, readManifest, SOURCE_REPOSITORY } from "../self-context.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("self inspection exposes bounded run identity and provenance only", async () => {
  const self = createSelfContext({
    context: { deploymentId: "dep_test", executionNodeId: "node_test", botName: "Scout", model: "openai/test", capabilities: ["memory", "browser", "bad value"] },
    releaseManifest: { version: "v1.2.3", commit: "a".repeat(40), image: { reference: "docker.io/example/app@sha256:" + "b".repeat(64) } },
  });
  const value = await self.inspect();
  assert.equal(value.trust, "limited_deployment_context");
  assert.equal(value.source.repository, SOURCE_REPOSITORY);
  assert.equal(value.botName, "Scout");
  assert.deepEqual(value.capabilities, ["memory", "browser"]);
  assert.equal("env" in value, false);
  assert.equal("apiKey" in value, false);
  assert.deepEqual(await self.inspect("identity"), { trust: "limited_deployment_context", botName: "Scout", model: "openai/test", nodeId: "node_test" });
  await assert.rejects(self.inspect("filesystem"), /unsupported self-awareness topic/);
});

test("self documentation is topic allowlisted and bounded", async () => {
  const self = createSelfContext();
  const memory = await self.docs("memory");
  assert.equal(memory.topic, "memory");
  assert.equal(memory.source, "docs/memory.md");
  assert.ok(memory.content.length <= 8000);
  const development = await self.docs("development");
  assert.equal(development.source, "docs/self-development.md");
  await assert.rejects(self.docs("../../package.json"), /unsupported self-documentation topic/);
});

test("release manifest loading accepts only the explicit release filename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "self-context-"));
  const file = path.join(root, "release-manifest.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 2, version: "v2.0.0", commit: "c".repeat(40), image: { reference: "docker.io/example/app@sha256:" + "d".repeat(64) }, secret: "never" }));
  const result = await readManifest(file);
  assert.deepEqual(result, { version: "v2.0.0", commit: "c".repeat(40), image: { reference: "docker.io/example/app@sha256:" + "d".repeat(64) } });
  assert.equal(await readManifest(path.join(root, "node-bundle-manifest.json")), undefined);
});

test("reports explicit hosting without inferring Cloudflare", async () => {
  const boat = createSelfContext({ context: { hostingProvider: "boat", deploymentId: "boat-local" } });
  assert.equal((await boat.inspect("deployment")).hostingProvider, "boat");
  const unknown = createSelfContext({ context: { deploymentId: "local" } });
  assert.equal((await unknown.inspect("deployment")).hostingProvider, "unknown");
});
