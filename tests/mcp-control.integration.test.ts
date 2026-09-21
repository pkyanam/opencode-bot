import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
import worker, { Workspace } from '../apps/control-worker/src/index';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new DatabaseSync(':memory:'); databases.push(database);
  const storage = { sql: { exec(query: string, ...values: any[]) {
    const statement = database.prepare(query);
    let changes = 0;
    const rows = statement.columns().length ? statement.all(...values) : (changes = Number(statement.run(...values).changes), []);
    return { rowsWritten: changes, toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } }, setAlarm: async () => {}, transactionSync: (fn: () => unknown) => fn() };
  const env: any = { APP_TOKEN: 'test-owner', RUNNER_TOKEN: 'test-runner' };
  const workspace = new Workspace({ storage, waitUntil: () => {} } as any, env);
  env.WORKSPACE = { idFromName: () => 'owner', get: () => workspace };
  const api = async (path: string, input?: unknown, token = env.APP_TOKEN) => {
    const response = await worker.fetch(new Request(`https://bot.test${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }), env);
    return { status: response.status, body: await response.json() as any };
  };
  const rpc = async (method: string, params: Record<string, unknown> = {}, token = env.APP_TOKEN) => {
    const response = await worker.fetch(new Request('https://bot.test/api/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': String(params.name) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'integration', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    }), env);
    return { status: response.status, body: await response.json() as any };
  };
  return { api, rpc };
}
it('routes MCP mutations through the durable workspace and enforces revocable client scope', async () => {
  const f = fixture();
  expect((await f.rpc('tools/list', {}, 'wrong')).status).toBe(401);
  const ownerTools = await f.rpc('tools/list');
  expect(ownerTools.body.result.tools.map((tool: any) => tool.name)).toContain('provider_configure');
  const invitation = await f.api('/api/pairing/invites', {});
  const paired = await f.api('/api/pairing/redeem', { code: invitation.body.code, deviceName: 'Test agent', clientType: 'native' }, '');
  expect(paired.status).toBe(201);
  const token = paired.body.deviceToken;
  expect(typeof token).toBe('string');
  const tools = await f.rpc('tools/list', {}, token);
  expect(tools.body.result.tools.map((tool: any) => tool.name)).not.toContain('provider_configure');
  expect((await f.rpc('tools/call', { name: 'provider_configure', arguments: { operation: 'key' } }, token)).status).toBe(404);
  const created = await f.rpc('tools/call', { name: 'bot_create', arguments: { name: 'MCP bot', instructions: 'Test', model: 'test/model' } }, token);
  expect(created.body.result.isError).not.toBe(true);
  const id = created.body.result.structuredContent.id;
  expect((await f.api('/api/bots')).body.some((bot: any) => bot.id === id)).toBe(true);
  const renamed = await f.rpc('tools/call', { name: 'bot_update', arguments: { id, name: 'Renamed' } }, token);
  expect(renamed.body.result.structuredContent.name).toBe('Renamed');
  const routine = await f.rpc('tools/call', { name: 'routine_create', arguments: { botId: id, title: 'Disabled', prompt: 'Test', intervalMinutes: 60, enabled: false } }, token);
  expect(routine.body.result.structuredContent.enabled).toBe(false);
  await f.api(`/api/pairing/devices/${paired.body.deviceId}/revoke`, {});
  expect((await f.rpc('tools/list', {}, token)).status).toBe(401);
});
