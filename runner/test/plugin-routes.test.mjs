import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createPluginRoutes, validatePackage } from "../plugin-routes.mjs";

async function request(routes, method, body, query = "") {
  const server = http.createServer((req, res) => routes.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/extensions/plugins${query}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } finally { server.close(); }
}

test("lists and mutates through the native CLI with isolated state", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-route-"));
  await fs.mkdir(path.join(workspace,"private/config/opencode"),{recursive:true});
  await fs.writeFile(path.join(workspace,"private/config/opencode/opencode.json"),JSON.stringify({plugins:["@scope/example@1.2.3"]}));
  const calls = [];
  const routes = createPluginRoutes({ workspace, runtimeRoot: path.join(workspace, "private"), updateConfiguration: (fn) => fn(), execFile: async (_file, args, options) => { calls.push({ args, options }); return { stdout: args[1] === "list" ? "@scope/example@1.2.3\n" : "installed\n", stderr: "" }; } });
  assert.deepEqual((await request(routes, "GET")).body.plugins, [{ package: "@scope/example@1.2.3", removable:true }]);
  assert.equal((await request(routes, "POST", { package: "@scope/example@1.2.3" })).status, 201);
  assert.equal((await request(routes, "DELETE", undefined, "?package=%40scope%2Fexample%401.2.3")).status, 200);
  assert.deepEqual(calls.map((call) => call.args), [["plugin", "add", "@scope/example@1.2.3"], ["plugin", "remove", "@scope/example@1.2.3"]]);
  assert.equal(calls[1].options.env.HOME, path.join(workspace, "private"));
  assert.equal(calls[1].options.env.XDG_CONFIG_HOME, path.join(workspace, "private", "config"));
});

test("rejects tags, URLs, git specs, and malformed versions", async () => {
  for (const value of ["foo", "foo@latest", "foo@^1.2.3", "foo@1.2.3-beta.1", "foo@1.2", "https://example.test/x", "foo@1.2.3/evil", "@scope/foo@1.2.3#x"]) {
    if (value === "foo@1.2.3-beta.1") assert.equal(validatePackage(value), value);
    else assert.throws(() => validatePackage(value), /exact npm/);
  }
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-route-"));
  const routes = createPluginRoutes({ workspace, execFile: async () => ({ stdout: "", stderr: "" }) });
  const response = await request(routes, "POST", { package: "foo@latest" });
  assert.equal(response.status, 400);
});

test("does not expose command output credentials", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-route-"));
  const routes = createPluginRoutes({ workspace, execFile: async () => ({ stdout: "token=super-secret\n", stderr: "" }) });
  const response = await request(routes, "POST", {package:"test-plugin@1.0.0"});
  assert.equal(response.body.output.includes("super-secret"), false);
});
