import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore, createServer } from "../server.mjs";

class FakeRuntime {
  constructor() { this.next = 1; this.approvals = []; this.interrupts = []; }
  async createSession(input) { this.createCalls ??= []; this.createCalls.push(input); return input?.sessionId ?? `ses_${this.next++}`; }
  async prompt() { return { id: "in_1" }; }
  async command(session, name, text) { this.commandCall = { session, name, text }; return { id: "cmd_1" }; }
  async nativeAction(session, name, input) { this.actionCall = { session, name, input }; return { compacted: true }; }
  async catalog(directory) { return { runtime: { name: "opencode2" }, location: directory, models: [{ id: "free", providerID: "test" }], providers: [], agents: [], commands: [{ name: "summarize", execution: "native-session-command" }], clientOnlyCommands: ["help"], mcp: [] }; }
  async interrupt(id) { this.interrupts.push(id); }
  async replyApproval(...args) { this.approvals.push(args); }
  async *events() { yield { type: "session.text.delta", properties: { sessionID: "ses_1", delta: "hello" } }; yield { type: "session.execution.succeeded", properties: { sessionID: "ses_1" } }; }
}

test("runner authenticates and returns durable run events", async () => {
  const server = createServer({ store: new RunStore(new FakeRuntime()), authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
  const unauthorized = await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ runId: "r1", prompt: "hi" }) });
  assert.equal(unauthorized.status, 401);
  const accepted = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ runId: "r1", prompt: "hi" }) });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await fetch(`${base}/runs/r1`, { headers: { authorization: "Bearer secret" } }).then((r) => r.json());
  assert.equal(result.status, "succeeded");
  assert.equal(result.final, "hello");
  assert.ok(result.events.every((event) => event.seq > 0));
  server.close();
});

test("duplicate run admission is idempotent", async () => {
  const fake = new FakeRuntime(); const store = new RunStore(fake);
  const a = await store.start({ runId: "same", prompt: "one" });
  const b = await store.start({ runId: "same", prompt: "one" });
  assert.equal(a.runId, b.runId); assert.equal(fake.next, 2);
  await assert.rejects(store.start({ runId: 'same', prompt: 'different' }), { statusCode: 409 });
});

test("existing sessions are re-entered so model changes are applied", async () => {
  const fake = new FakeRuntime(); const store = new RunStore(fake);
  await store.start({ runId: "first", prompt: "one", model: "opencode/big-pickle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.start({ runId: "second", sessionId: "ses_existing", prompt: "two", model: "opencode/mimo-v2.5-free" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.createCalls.at(-1).sessionId, "ses_existing");
  assert.equal(fake.createCalls.at(-1).model, "opencode/mimo-v2.5-free");
});

test("session actions use explicit v2 APIs and do not require an assistant message", async () => {
  const fake = new FakeRuntime(); const store = new RunStore(fake);
  await store.start({ runId: "compact-1", sessionId: "ses_existing", sessionAction: { name: "compact", input: { delivery: "full" } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const run = store.get("compact-1");
  assert.equal(run.status, "succeeded");
  assert.deepEqual(fake.actionCall, { session: "ses_existing", name: "compact", input: { delivery: "full" } });
  assert.deepEqual(run.actionResult, { compacted: true });
});

test("checkpoint refuses active work and maps product approval to v2 decision", async () => {
  const fake = new FakeRuntime(); const store = new RunStore(fake);
  await store.start({ runId: "active", prompt: "one" });
  await assert.rejects(() => store.checkpoint(), (error) => error.statusCode === 409);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const run = store.get("active");
  await store.approval(run, { requestId: "p1", decision: "approve" });
  assert.equal(fake.approvals.at(-1)[1], "p1");
  assert.equal(fake.approvals.at(-1)[2], "once");
});

test("quiescing blocks catalog and desktop startup while the archive is active", async () => {
  const fake = new FakeRuntime();
  const desktop = {
    status: () => ({ state: "paused" }),
    stream: async () => { throw new Error("desktop must not start while quiesced"); },
  };
  const store = new RunStore(fake);
  const server = createServer({ store, desktop, authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
  store.paused = true;
  const headers = { authorization: "Bearer secret" };
  const catalog = await fetch(`${base}/catalog`, { headers });
  const preview = await fetch(`${base}/preview`, { headers });
  assert.equal(catalog.status, 409);
  assert.equal(preview.status, 409);
  server.close();
});

test("runner instance identity is stable on the computer filesystem", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-bot-instance-"));
  const instanceIdFile = path.join(root, "computer-instance-id");
  const first = new RunStore(new FakeRuntime(), { stateDir: path.join(root, "runs-a"), instanceIdFile });
  const second = new RunStore(new FakeRuntime(), { stateDir: path.join(root, "runs-b"), instanceIdFile });
  assert.equal(first.instanceId, second.instanceId);
});

test("catalog is authenticated and native commands use the session command API", async () => {
  const fake = new FakeRuntime();
  const server = createServer({ store: new RunStore(fake), authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address(); const base = `http://127.0.0.1:${address.port}`;
  const catalog = await fetch(`${base}/catalog`, { headers: { authorization: "Bearer secret" } }).then((r) => r.json());
  assert.equal(catalog.models[0].id, "free");
  const accepted = await fetch(`${base}/runs`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ runId: "command-1", command: { name: "summarize", text: "this" } }) });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.commandCall, { session: "ses_1", name: "summarize", text: "this" });
  server.close();
});

test('provider failures retain their explanation instead of an empty success', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  let started = false;
  runtime.prompt = async () => { started = true; };
  runtime.wait = async () => {};
  runtime.messages = async () => started ? [{ id:'failed', type:'assistant', content:[], finish:'error', error:{type:'provider.transport',message:'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR'} }] : [];
  const store = new RunStore(runtime);
  await store.start({runId:'certificate',prompt:'Hello'});
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(store.public(store.get('certificate')).status,'failed');
  assert.equal(store.public(store.get('certificate')).error,'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR');
});

test('transient wait transport failures are retried while native execution continues', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => {};
  let waits = 0;
  let nativeFinished = false;
  runtime.messages = async () => nativeFinished ? [{ id: 'assistant-1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'finished' }] }] : [];
  runtime.wait = async () => {
    waits += 1;
    if (waits < 3) throw new Error('Transport');
    nativeFinished = true;
  };
  const store = new RunStore(runtime);
  await store.start({ runId: 'transport-retry', prompt: 'Continue' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const run = store.public(store.get('transport-retry'));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.final, 'finished');
  assert.equal(waits, 3);
  assert.deepEqual(runtime.interrupts, []);
});

test('Telegram final receipt uses the last textual assistant message and ignores a tool-only tail', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  let started = false;
  runtime.prompt = async () => { started = true; };
  runtime.wait = async () => {};
  runtime.messages = async () => started ? [
    { id: 'assistant-commentary', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: 'old commentary' }] },
    { id: 'assistant-tool', type: 'assistant', time: { created: 2 }, content: [{ type: 'tool', tool: 'search' }] },
    { id: 'assistant-final', type: 'assistant', time: { created: 3 }, content: [
      { type: 'text', text: 'final part one' },
      { type: 'tool', tool: 'handoff' },
      { type: 'text', text: 'final part two' },
    ] },
    { id: 'assistant-tail', type: 'assistant', time: { created: 4 }, content: [{ type: 'tool', tool: 'cleanup' }] },
  ] : [];
  const store = new RunStore(runtime);
  await store.start({ runId: 'textual-final', prompt: 'Continue' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const run = store.public(store.get('textual-final'));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.final, 'final part one\n\nfinal part two');
  assert.doesNotMatch(run.final, /old commentary/);
});

test('unrecoverable wait transport failure interrupts native ownership before review', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => {};
  runtime.wait = async () => { throw new Error('Transport'); };
  runtime.messages = async () => [];
  const store = new RunStore(runtime);
  await store.start({ runId: 'transport-lost', prompt: 'Continue' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const run = store.public(store.get('transport-lost'));
  assert.equal(run.status, 'needs_review');
  assert.deepEqual(runtime.interrupts, ['ses_1']);
});

test('prompt transport failure is reviewable and interrupts without replaying the prompt', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => { throw new Error('Transport'); };
  const store = new RunStore(runtime);
  await store.start({ runId: 'prompt-transport', prompt: 'Do this once' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const run = store.public(store.get('prompt-transport'));
  assert.equal(run.status, 'needs_review');
  assert.deepEqual(runtime.interrupts, ['ses_1']);
});

test('new runs remain blocked until deferred native interruption completes', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => { throw new Error('Transport'); };
  let signalInterruptStarted;
  const interruptStarted = new Promise(resolve => { signalInterruptStarted = resolve; });
  let releaseInterrupt;
  runtime.interrupt = async id => {
    runtime.interrupts.push(id);
    signalInterruptStarted();
    await new Promise(resolve => { releaseInterrupt = resolve; });
  };
  const store = new RunStore(runtime);
  await store.start({ runId: 'deferred-interrupt', prompt: 'Do this once' });
  await interruptStarted;
  assert.equal(store.get('deferred-interrupt').status, 'running');
  await assert.rejects(() => store.start({ runId: 'blocked', prompt: 'Do this next' }), error => error.statusCode === 409);
  releaseInterrupt();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.get('deferred-interrupt').status, 'needs_review');
});

test('certificate failures stop provider retries and require an explicit retry', async () => {
  const runtime=new FakeRuntime();
  runtime.events=async function* () { yield {type:'session.retry.scheduled',properties:{sessionID:'ses_1',attempt:1,error:{type:'provider.transport',message:'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR'}}}; };
  const store=new RunStore(runtime);
  await store.start({runId:'bad-network',prompt:'Hello'});
  await new Promise(resolve=>setTimeout(resolve,20));
  const run=store.public(store.get('bad-network'));
  assert.equal(run.status,'needs_review');
  assert.match(run.error,/secure connection/);
  assert.ok(runtime.interrupts.includes('ses_1'));
  assert.equal(runtime.createCalls.length,1);
});

test('provider settings use native auth, reject unauthenticated access, and never echo failed secrets', async () => {
  const runtime=new FakeRuntime(); runtime.providers=async()=>({integrations:[{id:'test',name:'Test',methods:[{type:'key'}],connections:[]}],providers:[]});
  runtime.configureProvider=async input=>{assert.equal(input.key,'private-test-key');throw Error('server echoed private-test-key');};
  const server=createServer({store:new RunStore(runtime),authToken:'secret'}); await new Promise(resolve=>server.listen(0,resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/providers`)).status,401);
    const headers={authorization:'Bearer secret','content-type':'application/json'};
    const list=await fetch(`${base}/providers`,{headers}).then(r=>r.json());assert.equal(list.integrations[0].id,'test');
    const failed=await fetch(`${base}/providers/key`,{method:'POST',headers,body:JSON.stringify({integrationID:'test',key:'private-test-key'})});
    assert.equal(failed.status,400);assert.doesNotMatch(await failed.text(),/private-test-key/);
  } finally {server.close();}
});
