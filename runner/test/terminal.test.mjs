import test from "node:test";
import assert from "node:assert/strict";
import { NativeSessionTerminal, terminalArgs } from "../terminal.mjs";

test("native terminal attaches the selected session without putting auth in argv", async () => {
  let spawnArgs;
  const pty = {
    spawn(command, args, options) {
      spawnArgs = { command, args, options };
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    },
  };
  const terminal = new NativeSessionTerminal({ serverUrl: "http://127.0.0.1:4096", sessionId: "ses_123", authEnv: { OPENCODE_SERVER_PASSWORD: "secret-value" }, ptyFactory: pty });
  await terminal.start();
  assert.deepEqual(spawnArgs.args, terminalArgs("http://127.0.0.1:4096", "ses_123"));
  assert.match(spawnArgs.command, /(?:^|[\\/])opencode2$/);
  assert.equal(spawnArgs.options.env.OPENCODE_SERVER_PASSWORD, "secret-value");
  assert.equal(spawnArgs.args.includes("secret-value"), false);
});

test("terminal preserves escape sequences and bounds polling scrollback", async () => {
  const pty = { spawn() { return { onData(cb) { this.data = cb; }, onExit() {}, write() {}, resize() {}, kill() {} }; } };
  const terminal = new NativeSessionTerminal({ serverUrl: "http://127.0.0.1:4096", sessionId: "ses_123", ptyFactory: pty, maxScrollback: 8 });
  await terminal.start();
  terminal.pty.data("\u001b[31mhello\u001b[0m\r\nworld");
  const result = terminal.read(0);
  assert.equal(result.truncated, true);
  assert.match(result.data, /world$/);
  assert.equal(result.closed, false);
});
