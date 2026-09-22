import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopController, JpegFrameParser, parseMjpegStream, createFfmpegMjpegStream } from "../desktop.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const hasFfmpeg = await promisify(execFile)("ffmpeg", ["-version"]).then(() => true).catch(() => false);

test("persistent MJPEG parser handles split frames with a bounded frame size", async () => {
  const parser = new JpegFrameParser(16);
  assert.equal(parser.push(Uint8Array.from([0xff, 0xd8, 1])).length, 0);
  assert.deepEqual(parser.push(Uint8Array.from([2, 0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9])), [Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]), Uint8Array.from([0xff, 0xd8, 3, 0xff, 0xd9])]);
  await assert.rejects(async () => { const p = new JpegFrameParser(4); p.push(Uint8Array.from([0xff, 0xd8, 1, 2, 3])); }, /size limit/);
});

test("persistent capture stream stops consumption when the last viewer leaves", async () => {
  let pulls = 0; let stopped = false;
  const desktop = new DesktopController({ captureStream: async function* () { while (!stopped) { pulls += 1; yield Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); await delay(2); } }, startDisplay: async () => ({}), stopDisplay: async () => undefined, startBrowser: async () => ({}), stopBrowser: async () => undefined });
  const response = await desktop.stream(); const reader = response.body.getReader(); await reader.read(); await reader.cancel(); await delay(20); stopped = true; const after = pulls; await delay(10); assert.equal(pulls, after); await desktop.close();
});

test("persistent ffmpeg MJPEG producer emits frames from a lavfi source", { skip: !hasFfmpeg }, async () => {
  const frames = []; let count = 0;
  for await (const frame of createFfmpegMjpegStream({ signal: new AbortController().signal, fps: 2, inputArgs: ["-f", "lavfi", "-i", "testsrc=size=16x16:rate=2"] })) { frames.push(frame); if (++count === 2) break; }
  assert.equal(frames.length, 2); assert.ok(frames.every((frame) => frame[0] === 0xff && frame[1] === 0xd8));
});

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
    { command: "xdotool", args: ["mousemove", "500", "125", "click", "--repeat", "1", "1"], input: undefined, display: ":99" },
    { command: "xdotool", args: ["click", "--repeat", "1", "5"], input: undefined, display: ":99" },
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

test("capture switches between passive and human-control rates and aborts on disconnect", async () => {
  const modes = [];
  const desktop = new DesktopController({
    startDisplay: async () => ({}), stopDisplay: async () => {}, startBrowser: async () => ({}), stopBrowser: async () => {}, runCommand: async () => "",
    captureStream: async function* ({ fps, signal }) {
      modes.push(fps);
      yield new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
    },
  });
  const response = await desktop.stream();
  const reader = response.body.getReader(); await reader.read();
  const lease = desktop.acquireControl();
  await delay(10);
  assert.deepEqual(modes, [3, 60]);
  await desktop.releaseControl(lease.token);
  await delay(10);
  assert.deepEqual(modes, [3, 60, 3]);
  await reader.cancel(); await delay(10);
  assert.equal(desktop.status().captureActive, false);
  await desktop.close();
});
