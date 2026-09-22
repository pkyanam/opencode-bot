import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { sha256File, safeSource, uploadFile, downloadFile } from "./node-transfer.mjs";

const manifestFor = (id, sourcePath, targetPath, bytes) => ({ version: 1, id, sourceNodeId: "node_a", targetNodeId: "node_b", sourcePath, targetPath, name: path.basename(targetPath), size: bytes.length, sha256: requireDigest(bytes), objectKey: `transfers/v1/${id}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
const requireDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("safe source rejects traversal and symlink paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-transfer-"));
  await mkdir(path.join(root, "in")); await writeFile(path.join(root, "in", "x"), "abc");
  await symlink(path.join(root, "in", "x"), path.join(root, "link"));
  await assert.rejects(() => safeSource(root, "../outside"), /workspace/);
  await assert.rejects(() => safeSource(root, "link"), /symlink/);
  assert.deepEqual(await sha256File(path.join(root, "in", "x")), { size: 3, sha256: requireDigest(Buffer.from("abc")) });
});

test("uploads a stream and downloads with digest verification and atomic destination", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "node-transfer-src-"));
  const destRoot = await mkdtemp(path.join(os.tmpdir(), "node-transfer-dst-"));
  const bytes = Buffer.from("streamed transfer bytes"); await mkdir(path.join(sourceRoot, "in")); await writeFile(path.join(sourceRoot, "in", "x.bin"), bytes);
  const manifest = manifestFor("tr_test", "in/x.bin", "out/x.bin", bytes); let uploaded;
  const fakeFetch = async (_url, init) => { uploaded = Buffer.from(await new Response(init.body).arrayBuffer()); return new Response(null, { status: 201 }); };
  await uploadFile({ baseUrl: "https://control.test", token: "upload", manifest, sourceRoot, fetcher: fakeFetch });
  assert.deepEqual(uploaded, bytes);
  const downloadFetch = async () => new Response(ReadableStreamFrom(bytes));
  await downloadFile({ baseUrl: "https://control.test", token: "download", manifest, destinationRoot: destRoot, fetcher: downloadFetch });
  assert.deepEqual(await readFile(path.join(destRoot, "out", "x.bin")), bytes);
});

test("streams through an actual local HTTP server and rejects a corrupt response", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "node-transfer-http-src-"));
  const destRoot = await mkdtemp(path.join(os.tmpdir(), "node-transfer-http-dst-"));
  const bytes = Buffer.from("http streamed payload"); await writeFile(path.join(sourceRoot, "x.bin"), bytes);
  const manifest = manifestFor("tr_http", "x.bin", "x.bin", bytes); let uploaded = Buffer.alloc(0);
  const server = createServer((request, response) => {
    if (request.method === "PUT") { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { uploaded = Buffer.concat(chunks); response.writeHead(201).end(); }); return; }
    response.writeHead(200, { "content-length": String(bytes.length) }); response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await uploadFile({ baseUrl: `http://127.0.0.1:${port}`, token: "u", manifest, sourceRoot });
    assert.deepEqual(uploaded, bytes);
    await downloadFile({ baseUrl: `http://127.0.0.1:${port}`, token: "d", manifest, destinationRoot: destRoot });
    assert.deepEqual(await readFile(path.join(destRoot, "x.bin")), bytes);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

function ReadableStreamFrom(bytes) { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); }
