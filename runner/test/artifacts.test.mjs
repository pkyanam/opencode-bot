import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchArtifactRequest } from "../artifacts.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-artifacts-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "hello.txt"), "hello");
  await writeFile(path.join(root, ".secret"), "do-not-list");
  await symlink(path.join(root, "nested"), path.join(root, "linked"));
  return root;
}

async function request(root, method, url, body) {
  const server = createServer((req, res) => void dispatchArtifactRequest(req, res, root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, body, headers: body ? { "content-type": "application/octet-stream" } : undefined });
  const bytes = Buffer.from(await response.arrayBuffer());
  await new Promise((resolve) => server.close(resolve));
  return { response, bytes };
}

test("artifact list hides dotfiles and symlinks", async () => {
  const root = await fixture();
  try {
    const { response, bytes } = await request(root, "GET", "/files");
    assert.equal(response.status, 200, bytes.toString());
    const result = JSON.parse(bytes.toString());
    assert.ok(result.artifacts.some((item) => item.path === "nested/hello.txt"));
    assert.ok(!result.artifacts.some((item) => item.path.startsWith(".")));
    assert.ok(!result.artifacts.some((item) => item.path.startsWith("linked")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact content and atomic upload work", async () => {
  const root = await fixture();
  try {
    const downloaded = await request(root, "GET", "/files/content?path=nested%2Fhello.txt");
    assert.equal(downloaded.response.status, 200, downloaded.bytes.toString());
    assert.equal(downloaded.bytes.toString(), "hello");
    const uploaded = await request(root, "POST", "/files?path=output.txt", "uploaded");
    assert.equal(uploaded.response.status, 201);
    assert.equal(await readFile(path.join(root, "output.txt"), "utf8"), "uploaded");
    const nested = await request(root, "POST", "/files?path=newdir%2Fdeeper%2Foutput.txt", "nested upload");
    assert.equal(nested.response.status, 201, nested.bytes.toString());
    assert.equal(await readFile(path.join(root, "newdir", "deeper", "output.txt"), "utf8"), "nested upload");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact workspace management creates, moves, and deletes safely", async () => {
  const root = await fixture();
  try {
    const created = await request(root, "POST", "/files/mkdir?path=projects%2Fdemo");
    assert.equal(created.response.status, 201, created.bytes.toString());
    const uploaded = await request(root, "POST", "/files?path=projects%2Fdemo%2Fnotes.txt", "notes");
    assert.equal(uploaded.response.status, 201);
    const moved = await request(root, "POST", "/files/move?from=projects%2Fdemo%2Fnotes.txt&to=projects%2Fdemo%2Frenamed.txt");
    assert.equal(moved.response.status, 200, moved.bytes.toString());
    assert.equal(await readFile(path.join(root, "projects/demo/renamed.txt"), "utf8"), "notes");
    const deleted = await request(root, "DELETE", "/files?path=projects%2Fdemo");
    assert.equal(deleted.response.status, 200, deleted.bytes.toString());
    await assert.rejects(readFile(path.join(root, "projects/demo/renamed.txt")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact workspace management rejects root and symlink mutations", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-artifacts-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "outside-link"));
    for (const [method, url] of [
      ["DELETE", "/files?path=."],
      ["POST", "/files/mkdir?path=linked%2Fnew"],
      ["POST", "/files/move?from=nested%2Fhello.txt&to=linked%2Fcopy.txt"],
      ["DELETE", "/files?path=linked"],
      ["DELETE", "/files?path=outside-link%2Fsecret.txt"],
      ["POST", "/files/move?from=outside-link%2Fsecret.txt&to=copy.txt"],
      ["POST", "/files/mkdir?path=outside-link%2Fnew"],
    ]) {
      const result = await request(root, method, url);
      assert.equal(result.response.status, 400, `${method} ${url}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("artifact paths reject traversal, hidden paths, and symlinks", async () => {
  const root = await fixture();
  try {
    for (const url of [
      "/files/content?path=..%2Fetc%2Fpasswd",
      "/files/content?path=%2Fetc%2Fpasswd",
      "/files/content?path=.secret",
      "/files/content?path=linked%2Fhello.txt",
    ]) {
      const { response } = await request(root, "GET", url);
      assert.equal(response.status, 400, url);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
