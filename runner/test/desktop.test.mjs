import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopController } from "../desktop.mjs";

test("desktop MJPEG capture is demand driven and emits real multipart frames", async () => {
  let captures = 0;
  const desktop = new DesktopController({
    fps: 5,
    startDisplay: async () => ({ fake: true }),
    stopDisplay: async () => undefined,
    startBrowser: async () => ({ fake: true }),
    stopBrowser: async () => undefined,
    captureFrame: async () => { captures += 1; return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); },
  });
  assert.equal(desktop.status().state, "stopped");
  const response = await desktop.stream();
  assert.match(response.headers.get("content-type"), /multipart\/x-mixed-replace/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /Content-Type: image\/jpeg/);
  assert.ok(captures >= 1);
  await reader.cancel();
  await delay(300);
  const stoppedAt = captures;
  await delay(300);
  assert.equal(captures, stoppedAt);
  assert.equal(desktop.status().captureActive, false);
  await desktop.close();
});

test("desktop refuses viewers over its configured limit", async () => {
  const desktop = new DesktopController({ maxViewers: 1, startDisplay: async () => ({}), stopDisplay: async () => undefined, startBrowser: async () => ({}), stopBrowser: async () => undefined, captureFrame: async () => new Uint8Array([1]) });
  const first = await desktop.stream();
  await assert.rejects(() => desktop.stream(), (error) => error.statusCode === 429);
  await first.body.cancel();
  await desktop.close();
});

test("desktop control leases bound normalized input and release held keys", async () => {
  const calls = [];
  const runCommand = async (command, args, input, display) => { calls.push({ command, args, input, display }); return command === "xclip" && args.includes("-out") ? "clipboard-value" : ""; };
  const desktop = new DesktopController({ width: 1000, height: 500, startDisplay: async () => ({}), stopDisplay: async () => undefined, startBrowser: async () => ({}), stopBrowser: async () => undefined, captureFrame: async () => new Uint8Array([1]), runCommand });
  await desktop.start();
  const lease = desktop.acquireControl("owner");
  await desktop.input(lease.token, { type: "click", x: 0.5, y: 0.25 });
  await desktop.input(lease.token, { type: "scroll", deltaY: 120 });
  await desktop.input(lease.token, { type: "key", key: "Shift", action: "down" });
  assert.throws(() => desktop.acquireControl("other"), /already controlled/);
  await desktop.releaseControl(lease.token);
  assert.deepEqual(calls.slice(0, 4), [
    { command: "xdotool", args: ["mousemove", "--sync", "500", "125", "click", "--repeat", "1", "1"], input: undefined, display: ":99" },
    { command: "xdotool", args: ["click", "--repeat", "1", "--button", "5"], input: undefined, display: ":99" },
    { command: "xdotool", args: ["keydown", "shift"], input: undefined, display: ":99" },
    { command: "xdotool", args: ["keyup", "shift"], input: undefined, display: ":99" },
  ]);
  const second = desktop.acquireControl("clipboard");
  await desktop.input(second.token, { type: "clipboard", action: "write", text: "secret" });
  assert.equal((await desktop.input(second.token, { type: "clipboard", action: "read" })).text, "clipboard-value");
  await desktop.releaseControl(second.token);
  await assert.rejects(() => desktop.input(lease.token, { type: "text", text: "secret" }), /control lease/);
  await desktop.close();
});

test("desktop control rejects unsafe shortcuts and out of range coordinates", async () => {
  const desktop = new DesktopController({ startDisplay: async () => ({}), stopDisplay: async () => undefined, startBrowser: async () => ({}), stopBrowser: async () => undefined, captureFrame: async () => new Uint8Array([1]), runCommand: async () => "" });
  await desktop.start();
  const lease = desktop.acquireControl();
  await assert.rejects(() => desktop.input(lease.token, { type: "click", x: 2, y: 0.5 }), /between/);
  await assert.rejects(() => desktop.input(lease.token, { type: "key", key: "Control+Q" }), /shortcut/);
  await desktop.close();
});

test("control lease expiry releases held keys without another request", async () => {
  const calls = [];
  const desktop = new DesktopController({ startDisplay: async () => ({}), stopDisplay: async () => undefined, startBrowser: async () => ({}), stopBrowser: async () => undefined, captureFrame: async () => new Uint8Array([1]), runCommand: async (...args) => { calls.push(args); return ""; } });
  await desktop.start();
  const lease = desktop.acquireControl();
  await desktop.input(lease.token, { type: "key", key: "Shift", action: "down" });
  desktop.controlLease.expiresAt = Date.now() + 5;
  desktop.armControlExpiry();
  await delay(100);
  assert.equal(desktop.controlStatus().active, false);
  assert.ok(calls.some((call) => call[0] === "xdotool" && call[1][0] === "keyup" && call[1][1] === "shift"));
  await desktop.close();
});
