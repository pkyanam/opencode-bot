import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();

async function waitFor(url: string, headers: HeadersInit): Promise<Response> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const result = await fetch(url, { headers }); if (result.status !== 503) return result; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function waitReady(url: string, headers: HeadersInit): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const result = await fetch(url, { headers }); const body = await result.json() as { state?: string }; if (body.state === "ready") return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for computer readiness`);
}

test("bundled control-local serves real Workspace and persists SQLite state", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "control-local-http-"));
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const env = { ...process.env, NODE_ENV: "production", APP_TOKEN: "integration-token", APP_PORT: String(port), OPENCODE_STATE: join(dir, "state.sqlite"), OPENCODE_OBJECTS: join(dir, "objects"), OPENCODE_COMPUTERS: join(dir, "computers") };
  await exec(process.execPath, [join(root, "packages/control-local/src/build.mjs")], { cwd: root });
  let child = execFile(process.execPath, [join(root, "packages/control-local/dist/control-local.js")], { cwd: root, env });
  const headers = { authorization: "Bearer integration-token" };
  try {
    const ready = await waitFor(`http://127.0.0.1:${port}/api/state`, headers);
    assert.equal(ready.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/bots`)).status, 401);
    const state = await ready.json() as { bots: unknown[] };
    assert.deepEqual(state.bots, []);
    const bot = await (await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Integration bot" }) })).json() as { id: string };
    assert.match(bot.id, /^bot_/);
    await waitReady(`http://127.0.0.1:${port}/api/computer/readiness`, headers);
    assert.ok([200, 201].includes((await fetch(`http://127.0.0.1:${port}/api/files?path=hello.txt`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: "hello" })).status));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/files/content?path=hello.txt`, { headers })).text(), "hello");
    const multipart = new FormData(); multipart.append("file", new Blob(["multipart payload"], { type: "text/plain" }), "multipart.txt");
    const uploaded = await (await fetch(`http://127.0.0.1:${port}/api/uploads`, { method: "POST", headers, body: multipart })).json() as { attachment?: { id: string } };
    assert.match(uploaded.attachment?.id ?? "", /^att_/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/uploads/${uploaded.attachment!.id}`, { headers })).text(), "multipart payload");
    child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve));
    child = execFile(process.execPath, [join(root, "packages/control-local/dist/control-local.js")], { cwd: root, env });
    const bots = await (await waitFor(`http://127.0.0.1:${port}/api/bots`, headers)).json() as Array<{ id: string }>;
    assert.equal(bots[0]?.id, bot.id);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
