import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { imageFingerprint } from "./release/image-fingerprint.mjs";

test("image fingerprint follows image inputs and ignores generated or web-only files", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-image-fingerprint-"));
  const inputs = ["images/computer/Dockerfile", "runner/server.mjs", "packages/runtime-opencode2/src/client.mjs", "packages/browser/src/index.ts", ".dockerignore"];
  for (const path of inputs) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const before = await imageFingerprint(root, inputs);
  await mkdir(join(root, "runner/node_modules/generated"), { recursive: true });
  await writeFile(join(root, "runner/node_modules/generated/cache.js"), "generated");
  await mkdir(join(root, "apps/web/dist"), { recursive: true });
  await writeFile(join(root, "apps/web/dist/index.js"), "web-only");
  assert.equal(await imageFingerprint(root, inputs), before);
  await writeFile(join(root, "packages/browser/src/index.ts"), "runtime change");
  assert.notEqual(await imageFingerprint(root, inputs), before);
});
