import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { ingestTransfer } from "../transfer-ingest.mjs";

test("transfer ingest verifies streamed hash and preserves existing destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "transfer-ingest-")); const target = path.join(root, "out.bin"); await writeFile(target, "original");
  const good = Buffer.from("new content"); const hash = createHash("sha256").update(good).digest("hex");
  const server = http.createServer((req, res) => void ingestTransfer(req, res, root)); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const { port } = server.address();
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/files/transfer?path=bad.bin`, { method: "POST", headers: { "x-transfer-sha256": "0".repeat(64), "x-transfer-size": String(good.length) }, body: good });
    assert.equal(bad.status, 422); assert.equal(await readFile(target, "utf8"), "original");
    const conflict = await fetch(`http://127.0.0.1:${port}/files/transfer?path=out.bin`, { method: "POST", headers: { "x-transfer-sha256": hash, "x-transfer-size": String(good.length) }, body: good });
    assert.equal(conflict.status, 409); assert.equal(await readFile(target, "utf8"), "original");
    const uploaded = await fetch(`http://127.0.0.1:${port}/files/transfer?path=received/out.bin`, { method: "POST", headers: { "x-transfer-sha256": hash, "x-transfer-size": String(good.length) }, body: good });
    assert.equal(uploaded.status, 201, await uploaded.text()); assert.equal(await readFile(path.join(root, "received/out.bin"), "utf8"), "new content");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
