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
