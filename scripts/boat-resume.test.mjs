import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('resume recovery restores enabled units once, respects updater and intentional stops',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ocbot-resume-'));
 try {
 const log=join(dir,'log'), marker=join(dir,'done');
 writeFileSync(join(dir,'systemctl'),`#!/bin/sh\necho "$*" >> "$LOG"\ncase "$*" in\n 'is-enabled --quiet opencode-bot.service') [ "$DISABLED" != 1 ];;\n 'is-active --quiet opencode-bot-updater.service') [ "$UPDATING" = 1 ];;\n 'is-active --quiet opencode-bot.service') [ "$READY" = 1 ];;\n *) exit 0;;\nesac\n`,{mode:0o755});
 const run=(env={})=>{const r=spawnSync('bash',[resolve('boat/resume-service.sh')],{env:{...process.env,PATH:dir+':'+process.env.PATH,LOG:log,OCBOT_RESUME_MARKER:marker,...env},encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 run({UPDATING:'1'});assert.doesNotMatch(readFileSync(log,'utf8'),/start --no-block/);
 writeFileSync(log,'');run({DISABLED:'1'});assert.doesNotMatch(readFileSync(log,'utf8'),/start --no-block/);
 writeFileSync(log,'');run();assert.match(readFileSync(log,'utf8'),/start --no-block opencode-bot.service/);assert.equal(existsSync(marker),false);
 run({READY:'1'});assert.ok(existsSync(marker));writeFileSync(log,'');run();assert.equal(readFileSync(log,'utf8'),'');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
