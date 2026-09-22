import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createInstallerUI, renderText, ttyAvailable } from "./setup/installer-ui.mjs";

class FakeStream extends EventEmitter {
  constructor({ tty = false } = {}) { super(); this.isTTY = tty; this.output = ""; this.raw = false; }
  write(value) { this.output += value; return true; }
  setRawMode(value) { this.raw = value; }
}

test("installer UI is safe and deterministic without a TTY", async () => {
  const input = new FakeStream(); const output = new FakeStream();
  const ui = createInstallerUI({ input, output, colors: false });
  assert.equal(ttyAvailable({ input, output }), false);
  assert.equal(await ui.select("Choose", ["one", "two"], { defaultIndex: 1 }), "two");
  ui.error("bad\u001b[31m\ninput");
  assert.match(output.output, /bad input/);
  assert.doesNotMatch(output.output, /\u001b\[31m/);
  ui.cleanup();
  assert.doesNotMatch(output.output, /\u001b\[\?25h/);
});

test("interactive selection responds to keyboard input and restores raw mode", async () => {
  const input = new FakeStream({ tty: true }); const output = new FakeStream({ tty: true });
  const ui = createInstallerUI({ input, output, colors: false });
  const choice = ui.select("Choose", [{ label: "first", value: 1 }, { label: "second", value: 2 }]);
  input.emit("data", Buffer.from("\u001b[B")); input.emit("data", Buffer.from("\r"));
  assert.equal(await choice, 2);
  assert.equal(input.raw, false);
  ui.cleanup();
  assert.ok(output.output.includes("\u001b[?25h"));
});

test("renderText strips terminal controls and collapses line breaks", () => {
  assert.equal(renderText("a\u0000b\u001b[2J\nc"), "ab c");
});

test("status panel keeps provider and stage visible", () => {
  const output = new FakeStream();
  const ui = createInstallerUI({ input: new FakeStream(), output, colors: false });
  ui.panel({ provider: "Boat", stage: "Verifying runner", startedAt: Date.now() - 1000 });
  assert.match(output.output, /OpenCode Bot/);
  assert.match(output.output, /Provider: Boat/);
  assert.match(output.output, /Stage: Verifying runner/);
  assert.match(output.output, /Elapsed: 1s/);
});
