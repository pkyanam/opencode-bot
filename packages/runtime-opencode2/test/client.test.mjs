import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await runtime.prompt("ses_1", "hello");
  await runtime.prompt("ses_1", "steer me", { messageId: "msg_123", delivery: "steer", resume: true });
  await runtime.interrupt("ses_1");
  assert.deepEqual(calls[0][1].model, { providerID: "openai", id: "gpt-5.6-luna" });
  assert.deepEqual(calls[1][1], { sessionID: "ses_1", text: "hello" });
  assert.deepEqual(calls[2][1], { sessionID: "ses_1", text: "steer me", id: "msg_123", resume: true, delivery: "steer" });
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

test("provider registry exposes native auth schema without credentials", async () => {
  const calls = [];
  const fake = {
    provider: {
      list: async (input) => { calls.push(["provider.list", input]); return { data: [{ id: "openai", name: "OpenAI", integrationID: "openai", activation: "enabled", package: "x", headers: { authorization: "sk-header-secret" }, settings: { apiKey: "sk-settings-secret" } }] }; },
      get: async (input) => { calls.push(["provider.get", input]); return { data: { id: "openai", name: "OpenAI", integrationID: "openai", activation: "enabled", package: "x", headers: { authorization: "sk-header-secret" } } }; },
    },
    integration: {
      list: async (input) => { calls.push(["integration.list", input]); return { data: [{ id: "openai", name: "OpenAI", methods: [{ type: "key", label: "API key", form: { fields: [{ key: "key", type: "text", secret: true }, { key: "apiKey", type: "text", default: "default-key-secret" }, { key: "publicURL", type: "text", default: "http://localhost" }] } }], connections: [{ type: "credential", id: "cred_1", label: "OpenAI" }] }] }; },
      get: async (input) => { calls.push(["integration.get", input]); return { data: { id: "openai", name: "OpenAI", methods: [{ type: "key", label: "API key", form: { fields: [{ key: "key", type: "text", secret: true }, { key: "apiKey", type: "text", default: "default-key-secret" }, { key: "publicURL", type: "text", default: "http://localhost" }] } }], connections: [{ type: "credential", id: "cred_1", label: "OpenAI", token: "connection-token-secret" }] } }; },
    },
  };
  const runtime = new OpenCode2Runtime({ client: fake, directory: "/workspace/shared" });
  const registry = await runtime.providers();
  assert.deepEqual(registry.providers[0], { id: "openai", integrationID: "openai", name: "OpenAI", activation: "enabled", package: "x" });
  assert.equal(registry.integrations[0].connections[0].id, "cred_1");
  assert.equal(JSON.stringify(registry).includes("sk-settings-secret"), false);
  assert.equal(JSON.stringify(registry).includes("sk-header-secret"), false);
  assert.equal(JSON.stringify(registry).includes("default-key-secret"), false);
  assert.equal(JSON.stringify(registry).includes("http://localhost"), true);
  assert.ok(calls.every(([, input]) => input.location.directory === "/workspace/shared"));
  const status = await runtime.providerStatus("openai");
  assert.equal(status.integration.methods[0].type, "key");
  assert.equal(JSON.stringify(status).includes("sk-header-secret"), false);
});

test("provider key configuration uses the native integration endpoint and never echoes the key", async () => {
  const calls = [];
  const runtime = new OpenCode2Runtime({ client: { integration: { connect: { key: async (input) => calls.push(input) } } } });
  const result = await runtime.configureProvider({ integrationID: "openai", key: "sk-test-secret", label: "primary", directory: "/project" });
  assert.deepEqual(result, { ok: true, integrationID: "openai" });
  assert.deepEqual(calls, [{ integrationID: "openai", location: { directory: "/project" }, key: "sk-test-secret", label: "primary" }]);
  assert.equal(JSON.stringify(result).includes("sk-test-secret"), false);
  await assert.rejects(runtime.configureProvider({ integrationID: "openai", key: "" }), /key is required/);
});

test("provider connection failures do not propagate credential-bearing upstream errors", async () => {
  const runtime = new OpenCode2Runtime({ client: { integration: { connect: { key: async () => { throw new Error("invalid key sk-upstream-secret"); } } } } });
  await assert.rejects(runtime.configureProvider({ integrationID: "openai", key: "sk-request-secret" }), (error) => {
    assert.equal(error.message, "OpenCode provider key connection failed");
    assert.equal(error.message.includes("sk-request-secret"), false);
    assert.equal(error.message.includes("sk-upstream-secret"), false);
    return true;
  });
});

test("provider OAuth methods preserve native attempt status while omitting secrets", async () => {
  const calls = [];
  const fake = { integration: { oauth: {
    connect: async (input) => { calls.push(["connect", input]); return { location: {}, data: { attemptID: "attempt_1", url: "https://login.example", instructions: "Open the URL", mode: "code", time: { created: 1, expires: 2 }, token: "secret" } }; },
    status: async (input) => { calls.push(["status", input]); return { data: { status: "pending", time: { created: 1, expires: 2 }, token: "secret" } }; },
    complete: async (input) => { calls.push(["complete", input]); },
    cancel: async (input) => { calls.push(["cancel", input]); },
  } } };
  const runtime = new OpenCode2Runtime({ client: fake, directory: "/project" });
  const started = await runtime.providerOAuthStart({ integrationID: "xai", methodID: "oauth", answer: { region: "us" } });
  assert.equal(started.attempt.attemptID, "attempt_1");
  assert.equal(JSON.stringify(started).includes("secret"), false);
  assert.deepEqual(await runtime.providerOAuthStatus({ integrationID: "xai", attemptID: "attempt_1" }), { status: { status: "pending", time: { created: 1, expires: 2 } } });
  await runtime.providerOAuthComplete({ integrationID: "xai", attemptID: "attempt_1", code: "one-time-code" });
  await runtime.providerOAuthCancel({ integrationID: "xai", attemptID: "attempt_1" });
  assert.deepEqual(calls, [
    ["connect", { integrationID: "xai", location: { directory: "/project" }, methodID: "oauth", answer: { region: "us" } }],
    ["status", { integrationID: "xai", attemptID: "attempt_1", location: { directory: "/project" } }],
    ["complete", { integrationID: "xai", attemptID: "attempt_1", location: { directory: "/project" }, code: "one-time-code" }],
    ["cancel", { integrationID: "xai", attemptID: "attempt_1", location: { directory: "/project" } }],
  ]);
});

test("custom provider writes the documented v2 config schema atomically and keeps key server-side", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-provider-"));
  try {
    const configDir = join(root, "config", "opencode");
    await (await import("node:fs/promises")).mkdir(configDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(join(configDir, "opencode.json"), JSON.stringify({ mcp: { servers: { browser: { type: "remote", url: "http://browser" } } }, providers: { existing: { name: "Existing" } } }));
    const runtime = new OpenCode2Runtime({ root, client: { server: { info: async () => ({}) } } });
    const result = await runtime.configureCustomProvider({ providerID: "local-ai", name: "Local AI", baseURL: "http://127.0.0.1:9123/v1", modelIDs: ["chat", "chat"], apiKey: "custom-api-secret", restart: false });
    assert.deepEqual(result, { ok: true, providerID: "local-ai", modelIDs: ["chat"], reloaded: false });
    const configPath = join(configDir, "opencode.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcp.servers.browser.url, "http://browser");
    assert.equal(config.providers.existing.name, "Existing");
    assert.deepEqual(config.providers["local-ai"], {
      name: "Local AI",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "custom-api-secret", baseURL: "http://127.0.0.1:9123/v1" },
      models: { chat: { name: "chat" } },
    });
    assert.equal((await stat(configPath)).mode & 0o077, 0);
    const status = await runtime.customProviderStatus("local-ai");
    assert.deepEqual(status, { configured: true, providerID: "local-ai", name: "Local AI", packageName: "@opencode/ai/providers/openai-compatible", baseURL: "http://127.0.0.1:9123/v1", modelIDs: ["chat"], hasApiKey: true });
    assert.equal(JSON.stringify(status).includes("custom-api-secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('computer browser is directly exposed and attaches to the live desktop CDP browser', async () => {
  const root=await mkdtemp(join(tmpdir(),'computer-browser-'));
  const directory=join(root,'workspace');
  const previousDisplay=process.env.DISPLAY;
  try {
    const runtime=new OpenCode2Runtime({root,directory,browser:true,
      desktop:{start:async()=>{},display:':99'},
      service:{ensure:async()=>({url:'http://127.0.0.1:4096'}),headers:()=>({})},
      openCodeFactory:()=>({server:{info:async()=>({})},mcp:{list:async()=>({data:[{name:'computer_browser',status:{status:'connected'}}]})}})
    });
    await runtime.start();
    for(const file of [join(root,'config/opencode/opencode.json'),join(directory,'opencode.json')]) {
      const config=JSON.parse(await readFile(file,'utf8'));
      const browser=config.mcp.servers.computer_browser;
      assert.equal(browser.codemode,false);
      assert.equal(browser.command[browser.command.indexOf('--cdp-endpoint')+1],'http://127.0.0.1:9222');
      assert.equal(browser.command.includes('--headless'),false);
      assert.equal(config.mcp.servers.browser,undefined);
    }
  } finally { if(previousDisplay===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=previousDisplay;await rm(root,{recursive:true,force:true}); }
});

test('concurrent catalog readers share one native hydration pass', async () => {
  let calls=0;
  const list=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {data:[{id:'test'}]};};
  const runtime=new OpenCode2Runtime({client:{model:{list},provider:{list},agent:{list},command:{list},mcp:{list}}});
  await Promise.all(Array.from({length:6},()=>runtime.catalog()));
  assert.equal(calls,5);
  await runtime.catalog();assert.equal(calls,5);
  runtime.catalogCache.clear();await runtime.catalog();assert.equal(calls,10);
});

test('transcript polls deduplicate while execution reads stay fresh', async () => {
  let calls=0;
  const runtime=new OpenCode2Runtime({client:{message:{list:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return {data:[{id:String(calls)}]};}}}});
  await Promise.all([runtime.messages('ses_x',{cache:true}),runtime.messages('ses_x',{cache:true})]);
  assert.equal(calls,1);
  await runtime.messages('ses_x');assert.equal(calls,2);
});
