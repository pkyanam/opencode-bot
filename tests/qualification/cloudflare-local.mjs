import assert from 'node:assert/strict';

const base = process.env.TEST_WORKER_URL ?? 'http://127.0.0.1:8789';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This destructive restore qualification is restricted to a local development Worker');
const token = process.env.TEST_APP_TOKEN ?? 'local-preview-token';
async function request(path, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(90000) });
}
const unauthorized = await fetch(`${base}/api/state`);
assert.equal(unauthorized.status, 401);
const status = await request('/api/computer/status');
assert.equal(status.status, 200, await status.text());
const filename = `qualification-${Date.now()}.txt`;
const original = 'Checkpoint qualification: original content\n';
const upload = await request(`/api/files?path=${filename}`, 'POST', original);
assert.equal(upload.status, 201, await upload.text());
const list = await request('/api/files');
assert.equal(list.status, 200);
assert.ok((await list.json()).artifacts.some(file => file.path === filename));
const checkpoint = await request('/api/computer/checkpoint', 'POST');
const checkpointBody = await checkpoint.text();
assert.equal(checkpoint.status, 200, checkpointBody);
assert.equal(JSON.parse(checkpointBody).status, 'committed');
const modified = await request(`/api/files?path=${filename}`, 'POST', 'modified after checkpoint\n');
assert.equal(modified.status, 201, await modified.text());
const restored = await request('/api/computer/restore', 'POST');
assert.equal(restored.status, 200, await restored.text());
const download = await request(`/api/files/content?path=${filename}`);
assert.equal(download.status, 200);
assert.equal(await download.text(), original);
const ready = await request('/api/computer/status');
assert.equal((await ready.json()).readiness, 'ready');
console.log(JSON.stringify({ ok: true, backend: 'real local Worker + Durable Object + Sandbox + R2', artifact: filename, checkpointRestore: true }, null, 2));
