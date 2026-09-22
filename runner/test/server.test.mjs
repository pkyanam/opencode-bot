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
  async removeSession(session) { this.removedSessions ??= []; this.removedSessions.push(session); }
  async catalog(directory) { return { runtime: { name: "opencode2" }, location: directory, models: [{ id: "free", providerID: "test" }], providers: [], agents: [], commands: [{ name: "summarize", execution: "native-session-command" }], clientOnlyCommands: ["help"], mcp: [] }; }
  async providers(directory) { return { location: directory, providers: [{ id: "test", name: "Test" }] }; }
  async configureProvider(input) { return { ok: true, integrationID: input.integrationID, key: input.key, apiKey: input.key }; }
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

test("authenticated node runtime operations are allowlisted and redact provider secrets", async () => {
  const server = createServer({ store: new RunStore(new FakeRuntime()), authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/runtime/operation`, { method: "POST", body: JSON.stringify({ operation: "catalog", input: {} }) })).status, 401);
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    const catalog = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "catalog", input: {} }) }).then((r) => r.json());
    assert.equal(catalog.result.location, "/workspace/shared");
    const roots = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "file_roots", input: {} }) }).then((r) => r.json());
    assert.deepEqual(roots.result, { workspace: "/workspace/shared", home: os.homedir(), root: path.parse("/workspace/shared").root });
    const provider = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "providers/key", input: { integrationID: "x", key: "do-not-return" } }) }).then((r) => r.json());
    assert.equal(provider.result.ok, true);
    assert.equal(provider.result.key, "[redacted]");
    assert.equal(provider.result.apiKey, "[redacted]");
    const rejected = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "shell", input: {} }) });
    assert.equal(rejected.status, 400);
  } finally { server.close(); }
});

test("computer file admin operations require explicit scope and stay behind runner auth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-computer-files-"));
  fs.writeFileSync(path.join(root, "note.txt"), "local node file");
  const server = createServer({ store: new RunStore(new FakeRuntime()), authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    const listed = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "file_list", input: { scope: "computer", path: root } }) }).then((r) => r.json());
    assert.equal(listed.result.artifacts[0].path, path.join(root, "note.txt"));
    const denied = await fetch(`${base}/runtime/operation`, { method: "POST", headers, body: JSON.stringify({ operation: "file_list", input: { path: root } }) });
    assert.equal(denied.status, 400);
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("run attachments become native file prompt parts", async () => {
  const fake = new FakeRuntime();
  fake.promptCalls = [];
  fake.prompt = async (session, prompt, options) => { fake.promptCalls.push({ session, prompt, options }); return { id: "in_attachment" }; };
  const store = new RunStore(fake);
  await store.start({ runId: "attachment-run", prompt: "inspect", directory: "/workspace/shared", attachments: [{ path: "uploads/att_1/report.pdf", name: "report.pdf", mimeType: "application/pdf" }] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(fake.promptCalls[0].options.files, [{ uri: "file:///workspace/shared/uploads/att_1/report.pdf", name: "report.pdf", description: "application/pdf" }]);
});

test("active-turn attachment steering preserves files through native admission", async () => {
  const fake = new FakeRuntime();
  fake.promptCalls = [];
  fake.prompt = async (session, prompt, options) => { fake.promptCalls.push({ session, prompt, options }); return { id: "in_steer_attachment" }; };
  const store = new RunStore(fake);
  store.runs.set("active-attachment", { id: "active-attachment", status: "running", sessionId: "ses_active", events: [], final: "", steeringMessages: [] });
  await store.steer(store.get("active-attachment"), { idempotencyKey: "steer-attachment", prompt: "inspect", delivery: "steer", attachments: [{ path: "uploads/att_1/x.png", name: "x.png", mimeType: "image/png" }] });
  assert.deepEqual(fake.promptCalls[0].options.files, [{ uri: "file:///workspace/shared/uploads/att_1/x.png", name: "x.png", description: "image/png" }]);
});

test("native steering is authenticated, durably idempotent, and uses a native message id", async () => {
  const fake = new FakeRuntime();
  fake.promptCalls = [];
  fake.prompt = async (session, prompt, options) => { fake.promptCalls.push({ session, prompt, options }); return { data: { id: options.messageId } }; };
  const store = new RunStore(fake);
  store.runs.set("steer-1", { id: "steer-1", status: "running", sessionId: "ses_steer", events: [], final: "", steeringMessages: [] });
  const server = createServer({ store, authToken: "secret" });
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ idempotencyKey: "input-1", prompt: "change direction", delivery: "steer" });
    assert.equal((await fetch(`${base}/runs/steer-1/messages`, { method: "POST", body })).status, 401);
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    const first = await fetch(`${base}/runs/steer-1/messages`, { method: "POST", headers, body }).then(r => r.json());
    const second = await fetch(`${base}/runs/steer-1/messages`, { method: "POST", headers, body }).then(r => r.json());
    assert.equal(first.status, "accepted");
    assert.deepEqual(second, first);
    assert.equal(fake.promptCalls.length, 1);
    assert.equal(fake.promptCalls[0].options.delivery, "steer");
    assert.match(fake.promptCalls[0].options.messageId, /^msg_/);
    assert.equal(store.public(store.get("steer-1")).steeringMessages[0].status, "accepted");
  } finally { server.close(); }
});

test("run terminal transition drains steering admitted before the native completion race", async () => {
  const fake = new FakeRuntime();
  let releaseWait;
  const waitEntered = new Promise(resolve => { releaseWait = resolve; });
  let releaseSteer;
  let steerStarted;
  const steerEntered = new Promise(resolve => { steerStarted = resolve; });
  fake.events = undefined;
  fake.prompt = async (session, prompt, options) => {
    if (options?.delivery === "steer") {
      steerStarted();
      await new Promise(resolve => { releaseSteer = resolve; });
      return { data: { id: options.messageId } };
    }
    return { id: "initial" };
  };
  fake.wait = async () => waitEntered;
  let completedMessages = false;
  fake.messages = async () => completedMessages ? [{ id: "assistant-1", type: "assistant", content: [{ type: "text", text: "done" }] }] : [];
  const store = new RunStore(fake);
  await store.start({ runId: "steer-race", prompt: "start" });
  for (let i = 0; i < 20 && store.get("steer-race").status !== "running"; i++) await new Promise(resolve => setTimeout(resolve, 1));
  const steering = store.steer(store.get("steer-race"), { idempotencyKey: "race-1", prompt: "steer", delivery: "steer" });
  await steerEntered;
  releaseWait();
  completedMessages = true;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.get("steer-race").status, "running");
  releaseSteer();
  assert.equal((await steering).status, "accepted");
  for (let i = 0; i < 20 && !isTerminalForTest(store.get("steer-race").status); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(store.get("steer-race").status, "succeeded", JSON.stringify(store.get("steer-race")));
});

function isTerminalForTest(status) { return ["succeeded", "failed", "cancelled", "needs_review"].includes(status); }

test("existing sessions are re-entered so model changes are applied", async () => {
  const fake = new FakeRuntime(); const store = new RunStore(fake);
  await store.start({ runId: "first", prompt: "one", model: "opencode/big-pickle" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.start({ runId: "second", sessionId: "ses_existing", prompt: "two", model: "opencode/mimo-v2.5-free" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.createCalls.at(-1).sessionId, "ses_existing");
  assert.equal(fake.createCalls.at(-1).model, "opencode/mimo-v2.5-free");
});

test("deleting a session fences new runs and removes its persisted receipts", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-delete-"));
  const fake = new FakeRuntime(); const store = new RunStore(fake, { stateDir });
  await store.start({ runId: "receipt-1", sessionId: "ses_delete", prompt: "one" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(stateDir, "receipt-1.json")));
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  fake.removeSession = async (session) => { fake.removedSessions ??= []; fake.removedSessions.push(session); await entered; };
  const server = createServer({ store, authToken: "secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/sessions/ses_delete`, { method: "DELETE" })).status, 401);
  const pending = fetch(`${base}/sessions/ses_delete`, { method: "DELETE", headers: { authorization: "Bearer secret" } });
  for (let i = 0; i < 20 && !fake.removedSessions?.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(fake.removedSessions, ["ses_delete"]);
  await assert.rejects(store.start({ runId: "during-delete", prompt: "two" }), { statusCode: 409 });
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(fake.removedSessions, ["ses_delete"]);
  assert.equal(store.get("receipt-1"), undefined);
  assert.equal(fs.existsSync(path.join(stateDir, "receipt-1.json")), false);
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
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
  run.status = 'waiting_approval';
  await store.approval(run, { requestId: "p1", decision: "approve" });
  assert.equal(fake.approvals.at(-1)[1], "p1");
  assert.equal(fake.approvals.at(-1)[2], "once");
  run.status = 'succeeded';
  await assert.rejects(() => store.approval(run, { requestId: "p1", decision: "approve" }), (error) => error.statusCode === 409);
});

test("checkpoint clears quiescence when preparation fails before returning an archive barrier", async () => {
  const fake = new FakeRuntime();
  fake.stop = async () => { throw new Error("runtime stop failed"); };
  const store = new RunStore(fake);
  await assert.rejects(() => store.checkpoint(), /runtime stop failed/);
  assert.equal(store.paused, false);
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

test('MCP control routes proxy native list and mutations without exposing config', async () => {
  const fake = new FakeRuntime();
  fake.mcpList = async directory => ({ location: directory, servers: [{ name: 'cloudflare', status: { status: 'needs_auth', error: 'authenticate' } }] });
  fake.mcpAdd = async input => { fake.mcpAdded = input; return { ok: true, server: input.server }; };
  const server = createServer({ store: new RunStore(fake), authToken: 'secret' });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const listed = await fetch(`${base}/mcps`, { headers }).then(response => response.json());
    assert.equal(listed.servers[0].name, 'cloudflare');
    const added = await fetch(`${base}/mcps/add`, { method: 'POST', headers, body: JSON.stringify({ server: 'cloudflare', config: { type: 'remote', url: 'https://mcp.example' } }) }).then(response => response.json());
    assert.deepEqual(added, { ok: true, server: 'cloudflare' });
    assert.equal(fake.mcpAdded.server, 'cloudflare');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('MCP OAuth reports manual-control guidance and allows read-only status during active work', async () => {
  const runtime = new FakeRuntime();
  runtime.providerOAuthStart = async () => ({ attempt: { attemptID: 'a1', url: 'https://login.example' } });
  runtime.providerOAuthStatus = async () => ({ status: { status: 'pending' } });
  const desktop = { controlStatus: () => ({ active: true }), start: async () => {}, stream: async () => { throw new Error('unused'); } };
  const store = new RunStore(runtime);
  store.runs.set('busy', { id: 'busy', status: 'running', sessionId: 's1', events: [], final: '' });
  const server = createServer({ store, desktop, authToken: 'secret' });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const start = await fetch(`${base}/mcps/oauth/start`, { method: 'POST', headers, body: JSON.stringify({ integrationID: 'cf', methodID: 'oauth' }) });
    assert.equal(start.status, 409);
    assert.match((await start.json()).error, /manual control/i);
    const status = await fetch(`${base}/mcps/oauth/status`, { method: 'POST', headers, body: JSON.stringify({ integrationID: 'cf', attemptID: 'a1' }) });
    assert.equal(status.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
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

test('wait timeout reconnects remain alive while native execution awaits approval', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => {};
  let waits = 0;
  let nativeFinished = false;
  runtime.messages = async () => nativeFinished ? [{ id: 'assistant-approval', type: 'assistant', content: [{ type: 'text', text: 'approved' }] }] : [];
  const store = new RunStore(runtime, { nativeWaitTimeoutMs: 1 });
  runtime.permissions = async () => store.get('approval-timeout').status === 'waiting_approval' ? [{ id: 'permission-1', action: 'shell', resources: [] }] : [];
  runtime.wait = async () => {
    waits += 1;
    if (waits < 4) {
      store.get('approval-timeout').status = 'waiting_approval';
      throw Object.assign(new Error('bounded wait elapsed'), { name: 'TimeoutError' });
    }
    nativeFinished = true;
    store.get('approval-timeout').status = 'running';
  };
  await store.start({ runId: 'approval-timeout', prompt: 'Continue' });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const run = store.public(store.get('approval-timeout'));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.final, 'approved');
  assert.equal(waits, 4);
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

test('structured native errors retain their nested message', async () => {
  const runtime = new FakeRuntime();
  runtime.events = undefined;
  runtime.prompt = async () => { throw { error: { message: 'Session not found: ses_old' } }; };
  const store = new RunStore(runtime);
  await store.start({ runId: 'structured-error', prompt: 'Continue' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.public(store.get('structured-error')).error, 'Session not found: ses_old');
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

test("HTTP cancellation interrupts a run waiting for approval and is idempotent", async () => {
  const runtime = new FakeRuntime();
  const store = new RunStore(runtime);
  store.runs.set('stop-me', {id:'stop-me',sessionId:'ses_stop',status:'waiting_approval',events:[],final:''});
  const server=createServer({store,authToken:'secret'});
  await new Promise(resolve=>server.listen(0,resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/runs/stop-me/cancel`;
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    for(let i=0;i<2;i++) {
      const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer secret','content-type':'application/json'},body:'{}'});
      assert.equal(response.status,200);
      assert.equal((await response.json()).status,'cancelled');
    }
    assert.deepEqual(runtime.interrupts,['ses_stop']);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('restart interrupts orphaned native sessions before admitting another bot', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runner-recovery-'));
  fs.writeFileSync(path.join(dir,'old.json'),JSON.stringify({id:'old',sessionId:'ses_old',status:'running',events:[]}));
  const runtime=new FakeRuntime();
  let release;
  runtime.interrupt=async id=>{runtime.interrupts.push(id);await new Promise(resolve=>{release=resolve;});};
  const store=new RunStore(runtime,{stateDir:dir});
  let admitted=false;
  const next=store.start({runId:'new',prompt:'hello'}).then(()=>{admitted=true;});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(admitted,false);
  assert.deepEqual(runtime.interrupts,['ses_old']);
  release();await next;
  assert.equal(store.get('old').ownershipStopped,true);
  await new Promise(resolve=>setTimeout(resolve,20));
  fs.rmSync(dir,{recursive:true,force:true});
});

test('restart fails closed if old native work cannot be stopped', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'runner-recovery-'));
  fs.writeFileSync(path.join(dir,'old.json'),JSON.stringify({id:'old',sessionId:'ses_old',status:'running',events:[]}));
  const runtime=new FakeRuntime();runtime.interrupt=async()=>{throw new Error('connection lost');};
  const store=new RunStore(runtime,{stateDir:dir});
  await assert.rejects(store.start({runId:'new',prompt:'hello'}),/connection lost/);
  assert.equal(store.ownershipUncertain,true);
  assert.equal(store.get('new'),undefined);
  fs.rmSync(dir,{recursive:true,force:true});
});
