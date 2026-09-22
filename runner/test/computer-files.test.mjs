import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { computerFileOperation, dispatchComputerFileRequest } from "../computer-files.mjs";

function request(root, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage();
    req.method = method; req.url = route;
    const chunks = []; const res = { headersSent: false, writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }, end(value) { this.body = Buffer.from(value ?? ""); resolve(this); }, write() {}, pipe() {} };
    req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(body); };
    dispatchComputerFileRequest(req, res).catch(reject);
  });
}

test("computer scope requires absolute paths and supports bounded listing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-files-")); await writeFile(path.join(root, "a.txt"), "hello");
  const listed = await request(root, "GET", `/files?scope=computer&path=${encodeURIComponent(root)}`); assert.equal(listed.statusCode, 200); assert.equal(JSON.parse(listed.body).scope, "computer");
  const relative = await request(root, "GET", "/files?scope=computer&path=relative"); assert.equal(relative.statusCode, 400);
});

test("file_stat returns bounded metadata and a sha256 without returning content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-file-stat-"));
  const target = path.join(root, "note.txt"); await writeFile(target, "hello");
  const result = await computerFileOperation("file_stat", { scope: "computer", path: target });
  assert.deepEqual(result, { scope: "computer", path: target, name: "note.txt", size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
  assert.equal(Object.hasOwn(result, "content"), false);
});

test("computer scope rejects symlink reads and does not overwrite by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-files-")); const source = path.join(root, "source"); await writeFile(source, "secret"); await symlink(source, path.join(root, "link"));
  const linked = await request(root, "GET", `/files/content?scope=computer&path=${encodeURIComponent(path.join(root, "link"))}`); assert.equal(linked.statusCode, 400);
  const existing = await request(root, "POST", `/files?scope=computer&path=${encodeURIComponent(source)}`, "new"); assert.equal(existing.statusCode, 400); assert.equal(await readFile(source, "utf8"), "secret");
});
