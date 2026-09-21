import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createExtensionRoutes } from "../extension-routes.mjs";

async function request(routes, method, payload) {
  const server = http.createServer((req, res) => routes.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/extensions/install`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}

test("installs a validated skill atomically below .agents/skills", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "extension-route-"));
  const routes = createExtensionRoutes({ workspace });
  const result = await request(routes, "POST", { files: [
    { path: "SKILL.md", content: "---\nname: sample-skill\ndescription: A sample skill\n---\nUse this." },
    { path: "references/readme.md", content: "reference" },
  ] });
  assert.equal(result.status, 201);
  assert.equal(result.body.path, ".agents/skills/sample-skill");
  assert.equal(await fs.readFile(path.join(workspace, ".agents/skills/sample-skill/SKILL.md"), "utf8"), "---\nname: sample-skill\ndescription: A sample skill\n---\nUse this.");
  const duplicate = await request(routes, "POST", { files: [{ path: "SKILL.md", content: "---\nname: sample-skill\ndescription: A sample skill\n---\nUse this." }] });
  assert.equal(duplicate.status, 409);
});

test("rejects traversal and malformed metadata", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "extension-route-"));
  const routes = createExtensionRoutes({ workspace });
  const traversal = await request(routes, "POST", { files: [{ path: "../SKILL.md", content: "x" }] });
  assert.equal(traversal.status, 400);
  const malformed = await request(routes, "POST", { files: [{ path: "SKILL.md", content: "# no frontmatter" }] });
  assert.equal(malformed.status, 400);
});
