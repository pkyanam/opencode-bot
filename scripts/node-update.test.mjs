import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { updateNode } from './node-update.mjs';

const script = new URL('./node-update.mjs', import.meta.url);

test('updater refuses active work before downloading a release', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opencode-node-update-test-'));
  const config = path.join(dir, 'node.json');
  await writeFile(config, JSON.stringify({ nodeId: 'n', nodeSecret: 's', runnerToken: 'r' }));
  const result = spawnSync(process.execPath, [script.pathname, '--config', config, '--node-home', dir], {
    encoding: 'utf8', env: { ...process.env, OCBOT_NODE_ACTIVE_WORK: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active work/);
});

test('updater help is available without a paired node', () => {
  const result = spawnSync(process.execPath, [script.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node-update\.mjs/);
});

test('transactional update stages, swaps, resumes, and preserves config/profile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opencode-node-update-'));
  const bundle = path.join(dir, 'bundle');
  const incoming = path.join(dir, 'incoming');
  await mkdir(path.join(bundle, 'runner'), { recursive: true });
  await mkdir(path.join(incoming, 'runner'), { recursive: true });
  await writeFile(path.join(bundle, 'marker'), 'old');
  await writeFile(path.join(incoming, 'marker'), 'new');
  const archive = path.join(dir, 'node-bundle.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', incoming, '.']);
  const bytes = await readFile(archive);
  const manifest = path.join(dir, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, version: 'v1.2.3', commit: 'a'.repeat(40), archive: { file: 'node-bundle.tar.gz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }));
  const config = path.join(dir, 'node.json');
  const saved = { nodeId: 'node', nodeSecret: 'secret', runnerToken: 'runner', runnerUrl: 'http://127.0.0.1:9' };
  await writeFile(config, `${JSON.stringify(saved)}\n`);
  await mkdir(path.join(dir, 'browser', 'profile'), { recursive: true });
  await writeFile(path.join(dir, 'browser', 'profile', 'keep'), 'profile');
  let active = true;
  const events = [];
  const serviceAdapter = { wasActive: () => active, stop: async () => { events.push('stop'); active = false; }, waitStopped: async () => {}, start: async () => { events.push('start'); active = true; }, validate: async () => events.push('validate') };
  let failReplacement = false;
  const runnerAdapter = { quiesce: async () => { events.push('quiesce'); return 'old-instance'; }, replacement: async () => { events.push('replacement'); if (failReplacement) { failReplacement = false; throw new Error('readiness failed'); } return saved; }, resume: async () => events.push('resume') };
  const result = await updateNode({ nodeHome: dir, config, manifest, archive, skipDependencies: true, serviceAdapter, runnerAdapter });
  assert.equal(result.version, 'v1.2.3');
  assert.equal(await readFile(path.join(bundle, 'marker'), 'utf8'), 'new');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), saved);
  assert.equal(await readFile(path.join(dir, 'browser', 'profile', 'keep'), 'utf8'), 'profile');
  assert.deepEqual(events, ['quiesce', 'stop', 'start', 'validate', 'replacement', 'resume']);
  await assert.rejects(stat(path.join(dir, 'update.lock')));

  const incoming2 = path.join(dir, 'incoming2');
  await mkdir(path.join(incoming2, 'runner'), { recursive: true });
  await writeFile(path.join(incoming2, 'marker'), 'broken');
  const archive2 = path.join(dir, 'node-bundle-2.tar.gz');
  execFileSync('tar', ['-czf', archive2, '-C', incoming2, '.']);
  const bytes2 = await readFile(archive2);
  const manifest2 = path.join(dir, 'manifest2.json');
  await writeFile(manifest2, JSON.stringify({ schemaVersion: 1, version: 'v1.2.4', commit: 'b'.repeat(40), archive: { file: 'node-bundle.tar.gz', size: bytes2.length, sha256: createHash('sha256').update(bytes2).digest('hex') } }));
  failReplacement = true;
  await assert.rejects(updateNode({ nodeHome: dir, config, manifest: manifest2, archive: archive2, skipDependencies: true, serviceAdapter, runnerAdapter }), /rolled back/);
  assert.equal(await readFile(path.join(bundle, 'marker'), 'utf8'), 'new');
  await assert.rejects(stat(path.join(dir, 'update.lock')));

  const tampered = path.join(dir, 'tampered.tar.gz');
  await writeFile(tampered, Buffer.concat([bytes2, Buffer.from('tampered')]));
  await assert.rejects(updateNode({ nodeHome: dir, config, manifest: manifest2, archive: tampered, skipDependencies: true, serviceAdapter, runnerAdapter }), /checksum or size/);
  assert.equal(active, true);

  const conflictingBackup = path.join(dir, `.bundle-backup-${process.pid}`);
  await mkdir(conflictingBackup, { recursive: true });
  await writeFile(path.join(conflictingBackup, 'sentinel'), 'keep');
  await assert.rejects(updateNode({ nodeHome: dir, config, manifest: manifest2, archive: archive2, skipDependencies: true, serviceAdapter, runnerAdapter }), /rolled back/);
  assert.equal(active, true);
  assert.ok(events.includes('start'));
  assert.ok(events.includes('resume'));
  assert.equal(await readFile(path.join(bundle, 'marker'), 'utf8'), 'new');
});
