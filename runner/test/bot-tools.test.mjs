import test from 'node:test';
import assert from 'node:assert/strict';
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
  const store=new RunStore({});
  store.runs.set('r2',{id:'r2',status:'running',allowBotMessaging:true,botDirectory:[{id:'scout',name:'Scout'}],events:[],delegationRequests:[]});
  const server=createServer({store,authToken:'owner',botToolToken:'limited'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'qualification',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bot-mcp.mjs',import.meta.url))],env:{BOT_TOOLS_URL:`http://127.0.0.1:${server.address().port}/bot-tools`,BOT_TOOLS_TOKEN:'limited'}});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['list_bots','send_message','get_replies','create_bot']);
    const result=await client.callTool({name:'send_message',arguments:{targetBotId:'scout',prompt:'Say hello'}});
    assert.equal(result.isError,undefined);
    assert.equal(JSON.parse(result.content[0].text).status,'queued');
    assert.equal(store.public(store.get('r2')).delegationRequests.length,1);
  } finally { await client.close(); server.close(); }
});

test('create_bot is bounded, idempotent per turn, and never exposes runner auth', async () => {
  const store=new RunStore({});
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
