import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NativeSessionTerminal } from "../terminal.mjs";

test("pinned OpenCode 2.0.11 TUI attaches the selected session and lists /commands", { timeout: 60_000 }, async (t) => {
  const cli = path.resolve("runner/node_modules/.bin/opencode2");
  let version;
  try { version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim(); } catch (error) { t.skip(`pinned OpenCode CLI unavailable: ${error.message}`); return; }
  assert.match(version, /v2\.0\.11$/);
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode2-terminal-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(root, "config", "opencode"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const port = await findPort();
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), OPENCODE_DIRECTORY: workspace, OPENCODE_SERVER_PASSWORD: "terminal-test-password" };
  const server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
  let serverError = ""; server.stderr.on("data", (chunk) => { serverError += chunk; });
  let terminal;
  try {
    const auth = { authorization: `Basic ${Buffer.from("opencode:terminal-test-password").toString("base64")}`, "content-type": "application/json" };
    await waitForHealth(`http://127.0.0.1:${port}`, auth, server, () => serverError);
    const created = await fetch(`http://127.0.0.1:${port}/api/session?directory=${encodeURIComponent(workspace)}`, { method: "POST", headers: auth, body: JSON.stringify({ title: "native terminal qualification" }) });
    const createdBody = await created.text();
    assert.equal(created.status, 200, createdBody);
    const sessionId = JSON.parse(createdBody).data.id;
    terminal = new NativeSessionTerminal({ command: cli, serverUrl: `http://127.0.0.1:${port}`, sessionId, cwd: workspace, authEnv: { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "terminal-test-password" } });
    await terminal.start();
    await waitUntil(() => terminal.output.length > 1_000);
    // The OpenCode TUI hydrates its command registry after the first render;
    // cold Linux images can take several seconds before the input is ready.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    terminal.write("/commands\r");
    await waitUntil(() => terminal.output.includes("/review"));
    assert.equal(terminal.sessionId, sessionId);
    assert.match(terminal.output, /\/commands/);
    assert.match(terminal.output, /\/review/);
    assert.equal(terminal.output.includes("terminal-test-password"), false);
  } finally {
    await terminal?.close();
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await rm(root, { recursive: true, force: true });
  }
});

async function findPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForHealth(base, headers, process, getError) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`OpenCode server exited: ${getError()}`);
    try { const response = await fetch(`${base}/global/health`, { headers }); if (response.ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OpenCode server health timed out: ${getError()}`);
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("timed out waiting for native TUI output");
}
