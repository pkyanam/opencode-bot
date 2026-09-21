import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const installer = readFileSync(new URL('./node-install.sh', import.meta.url), 'utf8');
test('node installer help works when piped to bash', () => {
 const result = spawnSync('bash', ['-s', '--', '--help'], {input:installer,encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/--pairing-token TOKEN/);
 assert.match(result.stdout,/defaults to this computer/);
});
test('node installer rejects incomplete flags before downloading', () => {
 for (const flag of ['--control-url','--pairing-token','--name','--version']) {
  const result = spawnSync('bash',['-s','--',flag],{input:installer,encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/needs a value/);
 }
});
