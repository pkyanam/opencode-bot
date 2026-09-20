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
