import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2Runtime, eventText } from "../src/client.mjs";

test("runtime qualifies service with isolated roots and maps v2 calls", async () => {
  const calls = []; const fakeClient = {
    server: { info: async () => ({ version: "2.0.11" }) },
    session: {
      create: async (input) => { calls.push(["create", input]); return { id: "ses_1" }; },
      prompt: async (input) => { calls.push(["prompt", input]); return { id: "in_1" }; },
      interrupt: async (input) => { calls.push(["interrupt", input]); },
      log: async function* (input) { calls.push(["log", input]); yield { seq: 1 }; }
    }, event: { subscribe: () => (async function* () {})() }, permission: { reply: async (input) => calls.push(["reply", input]) }
  };
  let ensureInput;
  const runtime = new OpenCode2Runtime({ root: "/workspace/state", directory: "/workspace/shared", client: fakeClient, service: { ensure: async (x) => { ensureInput = x; return { url: "http://127.0.0.1:4096" }; }, headers: () => ({}) } });
  assert.equal(await runtime.createSession({ model: "openai/gpt-5.6-luna" }), "ses_1");
  await runtime.prompt("ses_1", "hello"); await runtime.interrupt("ses_1");
  assert.deepEqual(calls[0][1].model, { providerID: "openai", id: "gpt-5.6-luna" });
  assert.deepEqual(calls[1][1], { sessionID: "ses_1", text: "hello" });
  assert.equal(eventText({ properties: { delta: "x" } }), "x");
  assert.equal(ensureInput, undefined, "injected client should avoid service startup");
});

test("catalog uses location-scoped native v2 APIs", async () => {
  const locationCalls = [];
  const fake = {
    model: { list: async (input) => { locationCalls.push(["model", input]); return { data: [{ id: "free", providerID: "local" }] }; } },
    provider: { list: async (input) => { locationCalls.push(["provider", input]); return { data: [] }; } },
    agent: { list: async (input) => { locationCalls.push(["agent", input]); return { data: [] }; } },
    command: { list: async (input) => { locationCalls.push(["command", input]); return { data: [{ name: "summarize" }] }; } },
    mcp: { list: async (input) => { locationCalls.push(["mcp", input]); return { data: [] }; } },
  };
  const runtime = new OpenCode2Runtime({ client: fake, directory: "/workspace/shared" });
  const catalog = await runtime.catalog();
  assert.equal(catalog.models[0].id, "free");
  assert.equal(catalog.commands[0].execution, "native-session-command");
  assert.ok(catalog.cliOnlyCommands.includes("help"));
  assert.equal(locationCalls.length, 5);
  assert.ok(locationCalls.every(([, input]) => input.location.directory === "/workspace/shared"));
});

test("catalog waits for lazy provider hydration and exposes native actions", async () => {
  let reads = 0;
  const fake = {
    model: { list: async () => ({ data: reads++ > 0 ? [{ id: "big-pickle", providerID: "opencode" }] : [] }) },
    provider: { list: async () => ({ data: reads > 1 ? [{ id: "opencode" }] : [] }) },
    agent: { list: async () => ({ data: [] }) },
    command: { list: async () => ({ data: [] }) },
    mcp: { list: async () => ({ data: [] }) },
  };
  const runtime = new OpenCode2Runtime({ client: fake, directory: "/workspace/shared" });
  const catalog = await runtime.catalog();
  assert.equal(catalog.models[0].id, "big-pickle");
  assert.ok(catalog.actions.some((action) => action.action === "compact"));
  assert.equal(reads > 1, true);
});

test("native session actions map to v2 compact and revert APIs", async () => {
  const calls = [];
  const fake = {
    session: {
      compact: async (input) => { calls.push(["compact", input]); return { ok: true }; },
      revert: {
        stage: async (input) => { calls.push(["stage", input]); return { ok: true }; },
        clear: async (input) => { calls.push(["clear", input]); return { ok: true }; },
        commit: async (input) => { calls.push(["commit", input]); return { ok: true }; },
      },
    },
  };
  const runtime = new OpenCode2Runtime({ client: fake });
  await runtime.nativeAction("ses_1", "compact");
  await runtime.nativeAction("ses_1", "undo", { messageID: "msg_1", files: true });
  await runtime.nativeAction("ses_1", "redo");
  await runtime.nativeAction("ses_1", "revert-commit");
  await runtime.nativeAction("ses_1", "revert-clear");
  assert.deepEqual(calls, [
    ["compact", { sessionID: "ses_1" }],
    ["stage", { sessionID: "ses_1", messageID: "msg_1", files: true }],
    ["clear", { sessionID: "ses_1" }],
    ["commit", { sessionID: "ses_1" }],
    ["clear", { sessionID: "ses_1" }],
  ]);
  await assert.rejects(runtime.nativeAction("ses_1", "undo"), /messageID is required/);
});
