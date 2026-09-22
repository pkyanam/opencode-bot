// Release qualification against real X11 tools inside the Linux image.
import assert from 'node:assert/strict';
import { DesktopController } from './desktop.mjs';
const desktop = new DesktopController();
let stage = 'startup';
try {
  await desktop.start();
  stage = 'acquire lease';
  const { token } = desktop.acquireControl('release-smoke');
  stage = 'live capture';
  const preview = await desktop.stream();
  const reader = preview.body.getReader();
  const captureTimeout = setTimeout(() => { void reader.cancel(); }, 15000);
  try {
    const frame = await reader.read();
    assert.equal(frame.done, false, 'desktop capture timed out');
    assert.match(new TextDecoder().decode(frame.value.slice(0, 120)), /image\/jpeg/);
  } finally { clearTimeout(captureTimeout); await reader.cancel(); }
  stage = 'browser viewport';
  const dimensions = await desktop.browserHandle.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(dimensions.width <= desktop.width && dimensions.height < desktop.height, 'browser viewport must fit display including chrome');
  stage = 'pointer move';
  await desktop.input(token, { type: 'move', x: 0.5, y: 0.5 });
  stage = 'pointer click';
  await desktop.input(token, { type: 'click', x: 0.5, y: 0.5 });
  stage = 'scroll';
  await desktop.input(token, { type: 'scroll', deltaY: 120 });
  stage = 'keyboard shortcut';
  await desktop.input(token, { type: 'key', key: 'Control+L', action: 'press' });
  stage = 'text via stdin';
  await desktop.input(token, { type: 'text', text: 'about:blank#desktop-control-smoke' });
  stage = 'submit navigation';
  await desktop.input(token, { type: 'key', key: 'Enter', action: 'press' });
  stage = 'navigation verification';
  await desktop.browserHandle.page.waitForURL('about:blank#desktop-control-smoke', { timeout: 10000 });
  stage = 'clipboard write';
  await desktop.input(token, { type: 'clipboard', action: 'write', text: 'Symbols: !@#$% café' });
  stage = 'clipboard read';
  const clipboard = await desktop.input(token, { type: 'clipboard', action: 'read' });
  assert.equal(clipboard.text, 'Symbols: !@#$% café');
  stage = 'release lease';
  await desktop.releaseControl(token);
  assert.equal(desktop.controlStatus().active, false);
  console.log('Real desktop pointer, keyboard, navigation, clipboard, and release passed');
} catch (error) {
  console.error(`Desktop smoke failed during ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
} finally {
  await desktop.close();
}
