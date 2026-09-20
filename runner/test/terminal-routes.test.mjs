import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTerminalRoutes } from "../terminal-routes.mjs";
import { NativeSessionTerminal } from "../terminal.mjs";

function fakePtyFactory() {
  const instances = [];
  return {
    instances,
    spawn(command, args, options) {
      const item = { command, args, options, writes: [], data: undefined, exit: undefined };
      instances.push(item);
      return {
        onData(callback) { item.data = callback; },
        onExit(callback) { item.exit = callback; },
        write(data) { item.writes.push(data); },
        resize(cols, rows) { item.resize = { cols, rows }; },
        kill() { item.killed = true; },
      };
    },
  };
}

test("terminal polling routes attach only the runner-selected session and proxy raw TUI bytes", async (t) => {
  const ptyFactory = fakePtyFactory();
  const routes = createTerminalRoutes({
    create: (connection) => new NativeSessionTerminal({ ...connection, ptyFactory }),
    resolveConnection: async (sessionId) => ({ sessionId, serverUrl: "http://opencode", authEnv: { OPENCODE_SERVER_PASSWORD: "private" } }),
    maxScrollback: 64,
  });
  const server = http.createServer((req, res) => routes.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const attach = await fetch(`${base}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "ses_exact" }) });
  assert.equal(attach.status, 201);
  const terminal = await attach.json();
  assert.equal(terminal.sessionId, "ses_exact");
  assert.equal(ptyFactory.instances[0].args.at(-1), "ses_exact");
  assert.equal(ptyFactory.instances[0].options.env.OPENCODE_SERVER_PASSWORD, "private");
  const competing = await fetch(`${base}/terminal/attach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "ses_other" }) });
  assert.equal(competing.status, 409);

  ptyFactory.instances[0].data("\u001b[2Jprompt> ");
  const output = await fetch(`${base}/terminal/${terminal.terminalId}/output?after=0`);
  const payload = await output.json();
  assert.equal(output.status, 200);
  assert.equal(payload.data, "\u001b[2Jprompt> ");
  const input = await fetch(`${base}/terminal/${terminal.terminalId}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "\u001b[A/commands\r" }) });
  assert.equal(input.status, 202);
  assert.deepEqual(ptyFactory.instances[0].writes, ["\u001b[A/commands\r"]);
  const resize = await fetch(`${base}/terminal/${terminal.terminalId}/resize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: 140, rows: 40 }) });
  assert.deepEqual(await resize.json(), { terminalId: terminal.terminalId, cols: 140, rows: 40 });
  const close = await fetch(`${base}/terminal/${terminal.terminalId}`, { method: "DELETE" });
  assert.equal(close.status, 200);
  assert.equal((await fetch(`${base}/terminal/${terminal.terminalId}/output`)).status, 404);
});

test("terminal routes do not accept endpoint or auth from browser", async () => {
  const routes = createTerminalRoutes({ resolveConnection: async () => { throw new Error("must not resolve"); } });
  const server = http.createServer((req, res) => routes.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "ses", serverUrl: "http://attacker", authEnv: { OPENCODE_SERVER_PASSWORD: "leak" } }) });
  assert.equal(response.status, 400);
  await new Promise((resolve) => server.close(resolve));
});
