import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RunStore, createServer } from '../server.mjs';

test('bot messaging capabilities are scoped, durable, bounded and distinct from runner auth', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'bot-tools-'));
  const store=new RunStore({}, {stateDir:dir});
  store.runs.set('r1',{id:'r1',status:'running',allowBotMessaging:true,botDirectory:[{id:'llama',name:'Llama'}],delegationHistory:[],delegationRequests:[],events:[]});
  const server=createServer({store,authToken:'owner',botToolToken:'limited'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(name,args={},token='limited')=>fetch(`${base}/bot-tools`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({name,arguments:args})});
  try {
    assert.equal((await call('list_bots',{},'owner')).status,401);
    assert.equal((await fetch(`${base}/runs/r1`,{headers:{authorization:'Bearer limited'}})).status,401);
    assert.deepEqual(await (await call('list_bots')).json(),{bots:[{id:'llama',name:'Llama'}]});
    assert.equal((await call('send_message',{targetBotId:'unknown',prompt:'hello'})).status,400);
    const args={targetBotId:'llama',prompt:'Introduce yourself'};
    const first=await(await call('send_message',args)).json();
    assert.equal(first.status,'queued');
    assert.equal((await(await call('send_message',args)).json()).id,first.id);
    const loaded=new RunStore({}, {stateDir:dir});
    assert.equal(loaded.get('r1').delegationRequests[0].id,first.id);
    store.get('r1').allowBotMessaging=false;
    assert.equal((await call('send_message',{...args,prompt:'another'})).status,409);
    store.get('r1').status='succeeded';
    assert.equal((await call('list_bots')).status,409);
  } finally { server.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('native MCP stdio handshake and tool call reach only bot capabilities', async () => {
  const store = new RunStore({});
  store.runs.set('r2',{id:'r2',status:'running',allowBotMessaging:true,botDirectory:[{id:'scout',name:'Scout'}],events:[],delegationRequests:[]});
  const server=createServer({store,authToken:'owner',botToolToken:'limited'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'qualification',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bot-mcp.mjs',import.meta.url))],env:{BOT_TOOLS_URL:`http://127.0.0.1:${server.address().port}/bot-tools`,BOT_TOOLS_TOKEN:'limited'}});
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool=>tool.name),['list_bots','send_message','send_file','get_replies','create_bot','inspect_self','self_docs','memory_search','memory_read','memory_remember','memory_update','memory_forget','memory_share','memory_retain','memory_recall','memory_reflect','memory_observations','memory_mental_models','memory_mental_model_create','memory_mental_model_delete','memory_mental_model_refresh']);
    const schemas = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]));
    assert.equal(schemas.memory_observations.properties._run.type, 'string');
    assert.equal(schemas.memory_mental_models.properties._run.type, 'string');
    assert.deepEqual(schemas.memory_mental_model_delete.required, ['id', '_run']);
    assert.deepEqual(schemas.memory_mental_model_refresh.required, ['id', '_run']);
    const result=await client.callTool({name:'send_message',arguments:{targetBotId:'scout',prompt:'Say hello'}});
    assert.equal(result.isError,undefined);
    assert.equal(JSON.parse(result.content[0].text).status,'queued');
    assert.equal(store.public(store.get('r2')).delegationRequests.length,1);
  } finally { await client.close(); server.close(); }
});

test('memory tools forward immediately through the coordinator capability and never send a source bot ID', async () => {
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    calls.push({ headers: request.headers, body: JSON.parse(await new Promise((resolve, reject) => { let data = ''; request.on('data', chunk => data += chunk); request.on('end', () => resolve(data)); request.on('error', reject); })) });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'mem_1', revision: 1 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const store = new RunStore({}, {});
  store.runs.set('memory-run', { id: 'memory-run', status: 'running', executionBotId: 'bot-secret-context', memoryTools: { url: `http://127.0.0.1:${upstream.address().port}/api/memory/tools`, token: 'memory-capability' } });
  const server = createServer({ store, authToken: 'owner', botToolToken: 'limited' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (name, args) => fetch(`http://127.0.0.1:${server.address().port}/bot-tools`, { method: 'POST', headers: { authorization: 'Bearer limited', 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  try {
    const result = await call('memory_remember', { content: 'Use the shared registry', title: 'Registry', tags: ['workspace'] });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(await result.text()), { id: 'mem_1', revision: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, 'Bearer memory-capability');
    assert.deepEqual(calls[0].body, { name: 'memory_remember', arguments: { content: 'Use the shared registry', title: 'Registry', tags: ['workspace'] }, runId: 'memory-run' });
    assert.equal('sourceBotId' in calls[0].body, false);
    assert.equal('executionBotId' in calls[0].body, false);
    assert.equal(JSON.stringify(store.public(store.get('memory-run'))).includes('memory-capability'), false);
  } finally { server.close(); upstream.close(); }
});

test('create_bot is bounded, idempotent per turn, and never exposes runner auth', async () => {
  const store=new RunStore({}, { botReceiptTimeoutMs: 50 });
  store.runs.set('r3',{id:'r3',status:'running',allowBotMessaging:true,botDirectory:[],events:[],delegationRequests:[],botCreationRequests:[]});
  const server=createServer({store,authToken:'owner',botToolToken:'limited'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const call=(name,args={},token='limited')=>fetch(`http://127.0.0.1:${server.address().port}/bot-tools`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({name,arguments:args})});
  try {
    const args={name:'Writer',instructions:'Draft concise reports.',model:'test/model'};
    const first=await (await call('create_bot',args)).json();
    assert.equal(first.status,'queued');
    assert.equal((await (await call('create_bot',args)).json()).id,first.id);
    assert.equal(store.get('r3').botCreationRequests.length,1);
    assert.equal((await call('create_bot',{name:'x'.repeat(161)})).status,400);
    assert.equal((await call('create_bot',{name:'No token'})).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/runs/r3`,{headers:{authorization:'Bearer limited'}})).status,401);
  } finally { server.close(); }
});

test('bot receipt snapshots resolve pending creation and refresh replies while the run is active', async () => {
  const store = new RunStore({});
  store.runs.set('receipt-run', { id: 'receipt-run', status: 'running', allowBotMessaging: true, botDirectory: [], delegationHistory: [], delegationRequests: [], botCreationRequests: [{ id: 'create-1', name: 'Writer', instructions: '', model: '', agent: '', status: 'pending' }], events: [] });
  const pending = store.botTool('create_bot', { name: 'Writer' });
  await new Promise(resolve => setImmediate(resolve));
  store.recordBotReceipts('receipt-run', { bots: [{ id: 'bot-new', name: 'Writer' }], creations: [{ requestId: 'create-1', status: 'created', bot: { id: 'bot-new', name: 'Writer' } }], replies: [{ id: 'reply-1', status: 'completed', result: 'done' }] });
  const result = await pending;
  assert.equal(result.status, 'created');
  assert.equal(result.bot.id, 'bot-new');
  assert.equal(store.get('receipt-run').delegationHistory[0].id, 'reply-1');
});

test('bot capabilities isolate concurrent runs', async () => {
  const store = new RunStore({});
  store.runs.set('run-a', { id: 'run-a', botToolCapability: 'a'.repeat(64), status: 'running', allowBotMessaging: true, botDirectory: [{ id: 'target-a', name: 'A' }], delegationRequests: [], events: [] });
  store.runs.set('run-b', { id: 'run-b', botToolCapability: 'b'.repeat(64), status: 'running', allowBotMessaging: true, botDirectory: [{ id: 'target-b', name: 'B' }], delegationRequests: [], events: [] });
  assert.deepEqual((await store.botTool('list_bots', { _run: 'a'.repeat(64) })).bots.map(bot => bot.id), ['target-a']);
  await assert.rejects(() => store.botTool('list_bots', { _run: 'c'.repeat(64) }), /active application conversation/);
  const queued = await store.botTool('send_message', { _run: 'b'.repeat(64), targetBotId: 'target-b', prompt: 'hello' });
  assert.equal(queued.targetBotId, 'target-b');
  assert.equal(store.get('run-a').delegationRequests.length, 0);
  assert.equal(store.get('run-b').delegationRequests.length, 1);
});
