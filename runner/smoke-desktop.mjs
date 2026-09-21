// Release qualification against real X11 tools inside the Linux image.
import assert from 'node:assert/strict';
import { DesktopController } from './desktop.mjs';
const desktop = new DesktopController();
try {
  await desktop.start();
  const { token } = desktop.acquireControl('release-smoke');
  await desktop.input(token, { type: 'move', x: 0.5, y: 0.5 });
  await desktop.input(token, { type: 'click', x: 0.5, y: 0.5 });
  await desktop.input(token, { type: 'scroll', deltaY: 120 });
  await desktop.input(token, { type: 'key', key: 'Control+L', action: 'press' });
  await desktop.input(token, { type: 'text', text: 'about:blank#desktop-control-smoke' });
  await desktop.input(token, { type: 'key', key: 'Enter', action: 'press' });
  await desktop.browserHandle.page.waitForURL('about:blank#desktop-control-smoke', { timeout: 10000 });
  await desktop.input(token, { type: 'clipboard', action: 'write', text: 'Symbols: !@#$% café' });
  const clipboard = await desktop.input(token, { type: 'clipboard', action: 'read' });
  assert.equal(clipboard.text, 'Symbols: !@#$% café');
  await desktop.releaseControl(token);
  assert.equal(desktop.controlStatus().active, false);
  console.log('Real desktop pointer, keyboard, navigation, clipboard, and release passed');
} finally {
  await desktop.close();
}
