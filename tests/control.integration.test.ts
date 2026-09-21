import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({ runs: new Map<string, any>(), submitted: [] as any[], calls: [] as string[], steerCalls: [] as any[], steerResponses: [] as any[], cancelResponses: [] as any[], failApproval: false, cancelStatus: 200, deleteStatus: 200, messages: [] as any[] }));
vi.mock('../packages/computer-cloudflare/src/index', () => ({
  CloudflareComputerProvider: class {
    async ensure() {
      return { transport: { fetch: async (path: string, init: RequestInit = {}) => {
        remote.calls.push(`${init.method ?? 'GET'} ${path}`);
        if (path === '/runs' && init.method === 'POST') {
          const input = JSON.parse(String(init.body)); remote.submitted.push(input);
          const run = { runId: input.runId, sessionId: input.sessionId ?? `session-${input.runId}`, status: 'running', events: [], final: '' };
          remote.runs.set(input.runId, run); return Response.json(run, { status: 202 });
        }
        if (/^\/runs\/[^/]+\/messages$/.test(path) && init.method === 'POST') {
          const input = JSON.parse(String(init.body)); remote.steerCalls.push(input);
          const configured = remote.steerResponses.shift() ?? { status: 200, body: { id: `native-${input.idempotencyKey}`, status: 'accepted' } };
          if (configured instanceof Error) throw configured;
          return Response.json(configured.body, { status: configured.status });
        }
        if (/^\/sessions\/[^/]+\/messages$/.test(path)) return Response.json({messages:remote.messages});
        if (/^\/sessions\/[^/]+$/.test(path) && init.method === 'DELETE') return Response.json(remote.deleteStatus === 200 ? { deleted: true } : { error: 'delete failed' }, { status: remote.deleteStatus });
        const match = path.match(/^\/runs\/([^/]+)(?:\/(cancel|approval))?$/);
        const run = match && remote.runs.get(match[1]);
        if (!run) return Response.json({ error: 'run not found' }, { status: 404 });
        if (match?.[2] === 'cancel') { const configured = remote.cancelResponses.shift() ?? { status: remote.cancelStatus, body: remote.cancelStatus === 200 ? run : { error: 'cancel failed' } }; if (configured.status !== 200) return Response.json(configured.body, { status: configured.status }); run.status = 'cancelled'; }
        if (match?.[2] === 'approval') { if (remote.failApproval) return Response.json({ error: 'refused' }, { status: 503 }); run.status = 'running'; }
        return Response.json(run);
      } } };
    }
  },
}));
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
import worker, { Workspace } from '../apps/control-worker/src/index';

const databases: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const alarms: number[] = [];
  const storage = {
    sql: { exec(query: string, ...args: any[]) {
      const statement = db.prepare(query);
      let rows: any[] = []; let changes = 0;
      if (statement.columns().length) rows = statement.all(...args);
      else changes = Number(statement.run(...args).changes);
      return { toArray: () => rows, one: () => rows[0], rowsWritten: changes, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    setAlarm: async (time: number) => { alarms.push(time); },
    deleteAlarm: async () => {},
    transactionSync: <T>(fn: () => T) => fn(),
  };
  const env: any = { APP_TOKEN: 'test-owner-token', RUNNER_TOKEN: 'test-runner-token', SANDBOX: {} };
  const state: any = { storage, blockConcurrencyWhile: (fn: () => Promise<any>) => fn(), waitUntil: () => {} };
  let workspace = new Workspace(state, env);
  env.WORKSPACE = { idFromName: () => 'owner', get: () => ({ fetch: (req: Request) => workspace.fetch(req) }) };
  const request = async (path: string, method = 'GET', input?: unknown, token: string | null = env.APP_TOKEN) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await worker.fetch(new Request(`https://bot.test${path}`, { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), env);
    return { status: response.status, body: await response.json() as any };
  };
  const create = async () => {
    const bot = await request('/api/bots', 'POST', { name: 'Builder', instructions: 'Check your work.', model: 'test/model' });
    const thread = await request('/api/threads', 'POST', { botId: bot.body.id, title: 'Example' });
    return { bot: bot.body, thread: thread.body };
  };
  return { db, request, create, env, alarms, alarm: () => workspace.alarm(), restart: () => { workspace = new Workspace(state, env); } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); remote.runs.clear(); remote.submitted.length = 0; remote.calls.length = 0; remote.steerCalls.length = 0; remote.steerResponses.length = 0; remote.cancelResponses.length = 0; remote.failApproval = false; remote.cancelStatus = 200; remote.deleteStatus = 200; remote.messages=[]; });

describe('durable control-plane integration with real SQLite', () => {
  it('fails closed without the owner token and handles malformed JSON shapes', async () => {
    const f = fixture();
    expect((await f.request('/api/state', 'GET', undefined, null)).status).toBe(401);
    expect((await f.request('/api/state', 'GET', undefined, 'wrong')).status).toBe(401);
    expect((await f.request('/api/bots', 'POST', null)).status).toBe(400);
    expect((await f.request('/api/state')).status).toBe(200);
    f.env.APP_TOKEN = undefined;
    expect((await f.request('/api/state', 'GET', undefined, 'test-owner-token')).status).toBe(401);
  });
  it('persists admission across object recreation and rejects conflicting idempotency keys', async () => {
    const f = fixture(); const { thread } = await f.create();
    const input = { threadId: thread.id, prompt: 'Inspect the project', idempotencyKey: 'command-1' };
    const a = await f.request('/api/runs', 'POST', input);
    f.restart(); const b = await f.request('/api/runs', 'POST', input);
    expect(a.status).toBe(202); expect(b.body.id).toBe(a.body.id);
    expect((await f.request('/api/state')).body.runs).toHaveLength(1);
    expect((await f.request('/api/runs', 'POST', { ...input, prompt: 'Different command' })).status).toBe(409);
  });
  it('serializes work, deduplicates replayed events and continues the same thread session', async () => {
    const f = fixture(); const { thread } = await f.create();
    const first = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'First', idempotencyKey: 'one' });
    const second = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Second', idempotencyKey: 'two' });
    await f.alarm(); await f.alarm(); expect(remote.submitted).toHaveLength(1);
    expect(remote.submitted[0]).toMatchObject({ model: 'test/model', systemPrompt: expect.stringContaining('Check your work.') });
    const r = remote.runs.get(first.body.id); r.events = [{ seq: 1, type: 'text', data: { text: 'Done' } }];
    await f.alarm(); await f.alarm();
    const detail = await f.request(`/api/runs/${first.body.id}`);
    expect(detail.body.events.filter((e: any) => e.type === 'runner.text')).toHaveLength(1);
    r.status = 'succeeded'; r.final = 'Done'; await f.alarm(); await f.alarm();
    expect(remote.submitted).toHaveLength(2);
    expect(remote.submitted[1]).toMatchObject({ runId: second.body.id, sessionId: r.sessionId });
  });
  it('does not replay work when its runner receipt disappears', async () => {
    const f = fixture(); const { thread } = await f.create();
    const run = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Send a message', idempotencyKey: 'one' });
    await f.alarm(); remote.runs.clear(); f.restart(); await f.alarm(); await f.alarm();
    expect(remote.submitted).toHaveLength(1);
    expect((await f.request(`/api/runs/${run.body.id}`)).body.status).toBe('needs_review');
  });
  it('cancels queued work without provisioning and interrupts admitted work', async () => {
    const f = fixture(); const { thread } = await f.create();
    const run = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'First', idempotencyKey: 'one' });
    await f.request(`/api/runs/${run.body.id}/cancel`, 'POST'); await f.alarm();
    expect(remote.submitted).toHaveLength(0);
    expect((await f.request(`/api/runs/${run.body.id}`)).body.status).toBe('cancelled');
    const active = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Second', idempotencyKey: 'two' });
    await f.alarm(); await f.request(`/api/runs/${active.body.id}/cancel`, 'POST'); await f.alarm();
    expect(remote.calls).toContain(`POST /runs/${active.body.id}/cancel`);
    expect((await f.request(`/api/runs/${active.body.id}`)).body.status).toBe('cancelled');
  });
  it('retries cancellation while the runner is waiting for approval and surfaces failed forwarding', async () => {
    const f = fixture(); const { thread } = await f.create();
    const active = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Needs approval', idempotencyKey: 'cancel-approval' });
    await f.alarm();
    const runner = remote.runs.get(active.body.id);
    runner.status = 'waiting_approval';
    runner.events = [{ seq: 1, type: 'permission.asked', data: { requestId: 'cancel-permission' } }];
    await f.alarm();
    expect((await f.request(`/api/runs/${active.body.id}`)).body.status).toBe('waiting_approval');

    remote.cancelResponses.push({ status: 503, body: { error: 'runner recovering' } });
    const cancelled = await f.request(`/api/runs/${active.body.id}/cancel`, 'POST');
    expect(cancelled.body.status).toBe('cancelling');
    expect((await f.request(`/api/runs/${active.body.id}/events`)).body).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'cancel.forward_error', payload: expect.objectContaining({ error: expect.stringContaining('runner cancel HTTP 503') }) }),
    ]));
    expect(runner.status).toBe('waiting_approval');

    await f.alarm();
    expect(remote.calls.filter((call) => call === `POST /runs/${active.body.id}/cancel`)).toHaveLength(2);
    await f.alarm();
    expect((await f.request(`/api/runs/${active.body.id}`)).body.status).toBe('cancelled');
  });
  it('refuses fabricated approvals', async () => {
    const f = fixture(); const { thread } = await f.create();
    const run = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'First', idempotencyKey: 'one' });
    expect((await f.request(`/api/runs/${run.body.id}/approval`, 'POST', { requestId: 'made-up', decision: 'approve' })).status).toBe(409);
  });
  it('persists skill assignment, edits, deletes, and injects selected instructions', async () => {
    const f = fixture(); const { bot, thread } = await f.create();
    const skill = await f.request('/api/skills', 'POST', { name: 'Verifier', description: 'Checks output', instructions: 'Always run the verification command.' });
    expect((await f.request(`/api/bots/${bot.id}/skills`, 'PUT', { skillIds: [skill.body.id] })).body).toHaveLength(1);
    expect((await f.request(`/api/skills/${skill.body.id}`, 'PATCH', { description: 'Updated' })).body.description).toBe('Updated');
    await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Build', idempotencyKey: 'skill-run' }); await f.alarm();
    expect(remote.submitted[0].systemPrompt).toContain('[Skill: Verifier]');
    expect((await f.request(`/api/skills/${skill.body.id}`, 'DELETE')).status).toBe(200);
    expect((await f.request(`/api/bots/${bot.id}/skills`)).body).toHaveLength(0);
  });
  it('injects memory and stops injecting it after deletion', async () => {
    const f = fixture(); const { bot, thread } = await f.create();
    const memory = await f.request(`/api/bots/${bot.id}/memory`, 'POST', { content: 'Prefer small safe changes.' });
    await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'One', idempotencyKey: 'memory-one' }); await f.alarm();
    expect(remote.submitted[0].systemPrompt).toContain('Prefer small safe changes.');
    const first = [...remote.runs.values()][0]; first.status = 'succeeded'; await f.alarm();
    expect((await f.request(`/api/bots/${bot.id}/memory/${memory.body.id}`, 'DELETE')).status).toBe(200);
    await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Two', idempotencyKey: 'memory-two' }); await f.alarm();
    expect(remote.submitted[1].systemPrompt).not.toContain('Prefer small safe changes.');
  });
  it('fires a due routine once and coalesces missed intervals', async () => {
    const f = fixture(); const { bot } = await f.create();
    const routine = await f.request('/api/routines', 'POST', { botId: bot.id, title: 'Hourly', prompt: 'Check status', intervalMinutes: 5 });
    f.db.prepare("UPDATE routines SET next_run_at=? WHERE id=?").run(new Date(Date.now() - 60 * 60_000).toISOString(), routine.body.id);
    await f.alarm(); await f.alarm();
    expect(remote.submitted).toHaveLength(1);
    const listed = (await f.request('/api/routines')).body.find((r: any) => r.id === routine.body.id); expect(Date.parse(listed.nextRunAt)).toBeGreaterThan(Date.now());
  });
  it('paused routines do not trigger and can be re-enabled', async () => {
    const f = fixture(); const { bot } = await f.create();
    const routine = await f.request('/api/routines', 'POST', { botId: bot.id, title: 'Paused', prompt: 'No-op', intervalMinutes: 5 });
    await f.request(`/api/routines/${routine.body.id}`, 'PATCH', { enabled: false }); f.db.prepare("UPDATE routines SET next_run_at=? WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), routine.body.id); await f.alarm(); expect(remote.submitted).toHaveLength(0);
    await f.request(`/api/routines/${routine.body.id}`, 'PATCH', { enabled: true }); await f.alarm(); expect(remote.submitted).toHaveLength(1);
  });
  it('exposes pending approval payload and enforces one-shot decisions', async () => {
    const f = fixture(); const { thread } = await f.create(); const run = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Approve', idempotencyKey: 'approval-one' }); await f.alarm(); const remoteRun=remote.runs.get(run.body.id); remoteRun.status='waiting_approval'; remoteRun.events=[{seq:1,type:'permission.asked',data:{requestId:'req-1',title:'Run command'}}]; await f.alarm();
    expect((await f.request(`/api/runs/${run.body.id}`)).body.pendingApproval).toMatchObject({ requestId:'req-1', payload:{requestId:'req-1',title:'Run command'} });
    expect((await f.request(`/api/runs/${run.body.id}/approval`, 'POST', { requestId:'req-1', decision:'approve' })).status).toBe(200);
    expect((await f.request(`/api/runs/${run.body.id}/approval`, 'POST', { requestId:'req-1', decision:'approve' })).status).toBe(409);
  });
  it('marks approval forwarding failure for review', async () => {
    const f = fixture(); const { thread } = await f.create(); const run = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Approve', idempotencyKey: 'approval-fail' }); await f.alarm(); const remoteRun=remote.runs.get(run.body.id); remoteRun.status='waiting_approval'; remoteRun.events=[{seq:1,type:'permission.asked',data:{requestId:'req-fail'}}]; await f.alarm(); remote.failApproval=true;
    expect((await f.request(`/api/runs/${run.body.id}/approval`, 'POST', { requestId:'req-fail', decision:'approve' })).body.status).toBe('needs_review');
  });
});

describe('native command and session action admission', () => {
  it('steers a same-thread active message once and deduplicates replayed admission', async () => {
    const f = fixture(); const { thread } = await f.create();
    const active = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Work on the issue', idempotencyKey: 'active-run' });
    await f.alarm();
    const input = { threadId: thread.id, prompt: 'Also check the tests', idempotencyKey: 'steer-1' };
    const first = await f.request('/api/runs', 'POST', input);
    const replay = await f.request('/api/runs', 'POST', input);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ id: active.body.id, messageQueued: true });
    expect(replay.body).toMatchObject({ id: active.body.id, messageQueued: true });
    expect((await f.request('/api/state')).body.pendingMessages).toHaveLength(1);

    await f.alarm();
    expect(remote.steerCalls).toEqual([{ idempotencyKey: 'steer-1', prompt: input.prompt, delivery: 'steer' }]);
    const state = (await f.request('/api/state')).body;
    expect(state.pendingMessages[0]).toMatchObject({ id: 'steer-1', runId: active.body.id, status: 'accepted', nativeId: 'native-steer-1' });
    expect((await f.request(`/api/runs/${active.body.id}/events`)).body.filter((event: any) => event.type === 'message.accepted')).toHaveLength(1);

    await f.request('/api/runs', 'POST', input); await f.alarm();
    expect(remote.steerCalls).toHaveLength(1);
  });

  it('falls back to a queued run when native steering safely reports not admitted', async () => {
    const f = fixture(); const { thread } = await f.create();
    const active = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Long task', idempotencyKey: 'active-fallback' });
    await f.alarm();
    remote.steerResponses.push({ status: 409, body: { notAdmitted: true } });
    const message = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Run this after the task', idempotencyKey: 'fallback-1' });
    await f.alarm();
    const state = (await f.request('/api/state')).body;
    const runs = state.runs.filter((run: any) => run.idempotencyKey === 'fallback-1');
    expect(remote.steerCalls).toHaveLength(1);
    expect(message.body.id).toBe(active.body.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prompt: 'Run this after the task', status: 'queued' });
    expect(state.pendingMessages).toEqual([]);

    remote.runs.get(active.body.id).status = 'succeeded';
    await f.alarm();
    await f.alarm();
    expect(remote.submitted.some((run: any) => run.runId === runs[0].id)).toBe(true);
  });

  it('marks an uncertain native delivery for review without creating a duplicate run', async () => {
    const f = fixture(); const { thread } = await f.create();
    const active = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Long task', idempotencyKey: 'active-uncertain' });
    await f.alarm();
    remote.steerResponses.push({ status: 503, body: { error: 'runner unavailable' } });
    await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Do not replay this', idempotencyKey: 'uncertain-1' });
    await f.alarm();
    const state = (await f.request('/api/state')).body;
    expect(remote.steerCalls).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].id).toBe(active.body.id);
    expect(state.pendingMessages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'uncertain-1', runId: active.body.id, status: 'needs_review' })]));
    expect((await f.request(`/api/runs/${active.body.id}/events`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delivery.uncertain', payload: expect.objectContaining({ id: 'uncertain-1' }) })]));

    for (let i = 0; i < 3; i++) await f.alarm();
    expect(remote.steerCalls).toHaveLength(1);
    expect((await f.request('/api/state')).body.runs).toHaveLength(1);
  });

  it('preserves any catalog command across restart and refuses conflicting retries', async () => {
    const f=fixture(); const {thread,bot}=await f.create();
    await f.request(`/api/bots/${bot.id}`,'PATCH',{agent:'plan'});
    const input={threadId:thread.id,command:{name:'review',text:'focus on concurrency'},idempotencyKey:'native-review'};
    const first=await f.request('/api/runs','POST',input);
    expect(first.status).toBe(202); f.restart();
    expect((await f.request('/api/runs','POST',input)).body.id).toBe(first.body.id);
    expect((await f.request('/api/runs','POST',{...input,command:{name:'different',text:'focus on concurrency'}})).status).toBe(409);
    await f.alarm();
    expect(remote.submitted[0].command).toEqual({name:'review',text:'focus on concurrency'});
    expect(remote.submitted[0].agent).toBe('plan');
    expect(remote.submitted[0].sessionAction).toBeUndefined();
  });
  it('keeps native actions distinct from command templates and validates undo', async () => {
    const f=fixture();const {thread}=await f.create();
    const invalid=await f.request(`/api/threads/${thread.id}/action`,'POST',{sessionAction:{name:'undo'},idempotencyKey:'undo-invalid'});
    expect(invalid.status).toBe(400);
    const input={sessionAction:{name:'revert-stage',input:{messageID:'msg_native',files:false}},idempotencyKey:'undo-valid'};
    expect((await f.request(`/api/threads/${thread.id}/action`,'POST',input)).status).toBe(202);
    await f.alarm();
    expect(remote.submitted[0].sessionAction).toEqual({name:'revert-stage',input:{messageID:'msg_native',files:false}});
    expect(remote.submitted[0].command).toBeUndefined();
  });
  it('routes the scheduled watchdog to the internal sweep', async () => {
    const f=fixture(); const fetch=vi.fn(async(_request: Request)=>Response.json({ok:true}));
    f.env.WORKSPACE.get=()=>({fetch});
    await worker.scheduled({} as any,f.env);
    expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe('/internal/sweep');
  });
});

it('keeps node pairing owner-only while admitting a single-use node credential', async () => {
  const f=fixture();
  expect((await f.request('/api/nodes/pairing','POST',{},null)).status).toBe(401);
  const pair=await f.request('/api/nodes/pairing','POST',{});
  expect(pair.status).toBe(201);
  const payload={pairingToken:pair.body.token,name:'My Mac',platform:'macos',arch:'arm64',capabilities:{runner:false}};
  const registered=await f.request('/api/nodes/register','POST',payload,null);
  expect(registered.status).toBe(201);
  expect((await f.request('/api/nodes/register','POST',payload,null)).status).toBe(401);
  expect((await f.request('/api/nodes','GET',undefined,registered.body.nodeSecret)).status).toBe(401);
  const listing=await f.request('/api/nodes');
  expect(listing.body.nodes[0].name).toBe('My Mac');
  expect(JSON.stringify(listing.body)).not.toContain(registered.body.nodeSecret);
});

it('admits Telegram webhooks only through their own secret validation',async()=>{
  const f=fixture();
  const {bot}=await f.create();
  expect((await f.request(`/api/bots/${bot.id}/telegram`)).body.config).toBe(null);
  expect((await f.request(`/api/bots/${bot.id}/telegram/configure`,'POST',{},null)).status).toBe(401);
  expect((await f.request(`/api/integrations/telegram/webhook/${bot.id}`,'POST',{update_id:1},null)).status).toBe(404);
});

it('keeps multiple named conversations per bot independent across restarts',async()=>{
  const f=fixture(); const {bot,thread}=await f.create();
  const second=await f.request('/api/threads','POST',{botId:bot.id,title:'Second task'});
  expect(second.body.id).not.toBe(thread.id);
  expect((await f.request(`/api/threads/${thread.id}`,'PATCH',{title:'Research notes'})).body.title).toBe('Research notes');
  expect((await f.request(`/api/threads/${thread.id}`,'PATCH',{title:' '})).status).toBe(400);
  f.restart();
  const all=await f.request('/api/threads');
  expect(all.body.map((t:any)=>t.title).sort()).toEqual(['Research notes','Second task']);
});

it('deletes one conversation while preserving its bot and sibling conversation', async () => {
  const f = fixture(); const { bot, thread } = await f.create();
  const sibling = (await f.request('/api/threads', 'POST', { botId: bot.id, title: 'Keep me' })).body;
  const oldRun = await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Remember this', idempotencyKey: 'delete-thread' });
  await f.request(`/api/runs/${oldRun.body.id}/cancel`, 'POST');
  const deleted = await f.request(`/api/threads/${thread.id}`, 'DELETE');
  expect(deleted.status).toBe(200);
  expect(deleted.body.nativeSessionsDeleted).toBe(0);
  expect((await f.request(`/api/threads/${thread.id}`, 'PATCH', { title: 'gone' })).status).toBe(404);
  expect((await f.request('/api/threads')).body.map((item: any) => item.id)).toEqual([sibling.id]);
  expect((await f.request("/api/bots")).body.map((item: any) => item.id)).toContain(bot.id);
  expect((await f.request("/api/runs")).body).toHaveLength(0);
  f.restart();
  expect((await f.request("/api/threads")).body.map((item: any) => item.id)).toEqual([sibling.id]);
});

it('rejects deletion while a bot has an active run, then deletes all of its threads', async () => {
  const f = fixture(); const { bot, thread } = await f.create();
  const sibling = (await f.request('/api/threads', 'POST', { botId: bot.id, title: 'Second' })).body;
  await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Still running', idempotencyKey: 'active-delete' });
  expect((await f.request(`/api/bots/${bot.id}`, 'DELETE')).status).toBe(409);
  const run = (await f.request('/api/runs')).body[0];
  await f.request(`/api/runs/${run.id}/cancel`, 'POST');
  const deleted = await f.request(`/api/bots/${bot.id}`, 'DELETE');
  expect(deleted.status).toBe(200);
  expect(deleted.body.counts.threads).toBe(2);
  expect((await f.request('/api/threads')).body).toHaveLength(0);
  expect((await f.request('/api/bots')).body).toHaveLength(0);
  expect(sibling.id).toBeTruthy();
});

it('allows deletion after a created handoff continuation has completed', async () => {
  const f = fixture(); const { bot, thread } = await f.create();
  const run = (await f.request('/api/runs', 'POST', { threadId: thread.id, prompt: 'Finished', idempotencyKey: 'completed-handoff' })).body;
  await f.request(`/api/runs/${run.id}/cancel`, 'POST');
  f.db.prepare("INSERT INTO delegation_continuations (source_run_id,status,continuation_run_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(run.id, 'created', run.id, new Date().toISOString(), new Date().toISOString());
  const deleted = await f.request(`/api/bots/${bot.id}`, 'DELETE');
  expect(deleted.status).toBe(200);
});

it('rejects deletion of owned-node conversations instead of claiming native removal', async () => {
  const f = fixture();
  const pair = await f.request('/api/nodes/pairing', 'POST', {});
  const registered = await f.request('/api/nodes/register', 'POST', {
    pairingToken: pair.body.token, name: 'Delete node', platform: 'linux', arch: 'x64', capabilities: { runner: true },
  }, null);
  const bot = await f.request('/api/bots', 'POST', { name: 'Owned delete', model: 'test/model', nodeId: registered.body.node.id });
  const thread = await f.request('/api/threads', 'POST', { botId: bot.body.id, title: 'Owned conversation' });
  const deleted = await f.request(`/api/threads/${thread.body.id}`, 'DELETE');
  expect(deleted.status).toBe(409);
  expect(deleted.body.error).toMatch(/owned-node conversations cannot be deleted/);
  expect((await f.request('/api/threads')).body.some((item: any) => item.id === thread.body.id)).toBe(true);
});

it('preserves Telegram chat bindings when deleting their conversation', async () => {
  const f = fixture(); const { bot, thread } = await f.create();
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any) => Response.json({ ok: true, result: String(url).endsWith('/getMe') ? { id: 123, is_bot: true, username: 'test_bot', first_name: 'Test' } : [] })) as any;
  try {
    expect((await f.request(`/api/bots/${bot.id}/telegram/configure`, 'POST', { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', transport: 'polling' })).status).toBe(200);
    f.db.prepare('INSERT INTO telegram_chat_bindings VALUES (?,?,?,?,?,?)').run(bot.id, 'delete-chat', 'delete-chat', 'owner', thread.id, new Date().toISOString());
    expect((await f.request(`/api/threads/${thread.id}`, 'DELETE')).status).toBe(200);
    const binding = f.db.prepare('SELECT thread_id FROM telegram_chat_bindings WHERE bot_id=? AND chat_id=?').get(bot.id, 'delete-chat') as any;
    expect(binding.thread_id).toBeNull();
  } finally { globalThis.fetch = original; }
});

it('keeps control-plane data when native session deletion fails', async () => {
  const f = fixture(); const { thread } = await f.create();
  f.db.prepare('UPDATE threads SET runner_session_id=? WHERE id=?').run('native-failure', thread.id);
  remote.deleteStatus = 503;
  const deleted = await f.request(`/api/threads/${thread.id}`, 'DELETE');
  expect(deleted.status).toBe(502);
  expect((await f.request('/api/threads')).body.some((item: any) => item.id === thread.id)).toBe(true);
  expect(remote.calls).toContain('DELETE /sessions/native-failure');
});

it('rejects deletion when a native session is shared by another conversation', async () => {
  const f = fixture(); const { bot, thread } = await f.create();
  const sibling = (await f.request('/api/threads', 'POST', { botId: bot.id, title: 'Shared session sibling' })).body;
  f.db.prepare('UPDATE threads SET runner_session_id=? WHERE id IN (?,?)').run('shared-native', thread.id, sibling.id);
  const deleted = await f.request(`/api/threads/${thread.id}`, 'DELETE');
  expect(deleted.status).toBe(409);
  expect(deleted.body.error).toMatch(/native conversation is shared/);
  expect(remote.calls).not.toContain('DELETE /sessions/shared-native');
  expect((await f.request('/api/threads')).body.map((item: any) => item.id)).toEqual(expect.arrayContaining([thread.id, sibling.id]));
});

it('routes an affinity thread to its owned node job and reconciles the durable receipt', async () => {
  const f = fixture();
  const pair = await f.request('/api/nodes/pairing', 'POST', {});
  const registered = await f.request('/api/nodes/register', 'POST', {
    pairingToken: pair.body.token,
    name: 'Runner laptop',
    platform: 'macos',
    arch: 'arm64',
    capabilities: { runner: true },
  }, null);
  const bot = await f.request('/api/bots', 'POST', { name: 'Owned', instructions: 'Be precise.', model: 'test/model', nodeId: registered.body.node.id });
  const thread = await f.request('/api/threads', 'POST', { botId: bot.body.id, title: 'Owned conversation' });
  expect(thread.body.nodeId).toBe(registered.body.node.id);
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Run remotely', idempotencyKey: 'owned-run-1' });
  await f.alarm();
  expect(remote.submitted).toHaveLength(0);
  const leased = await f.request(`/api/nodes/${registered.body.node.id}/jobs/poll`, 'GET', undefined, registered.body.nodeSecret);
  expect(leased.body.job.payload).toMatchObject({ kind: 'runner.run', run: { runId: run.body.id, model: 'test/model' } });
  await f.request(`/api/nodes/${registered.body.node.id}/jobs/${leased.body.job.id}/result`, 'POST', {
    ok: true,
    result: { status: 'succeeded', runId: run.body.id, sessionId: 'owned-session', final: 'remote done', events: [] },
  }, registered.body.nodeSecret);
  await f.alarm();
  expect((await f.request(`/api/runs/${run.body.id}`)).body).toMatchObject({ status: 'succeeded', result: 'remote done' });
  expect((await f.request('/api/state')).body.threads.find((item: any) => item.id === thread.body.id).sessionId).toBe('owned-session');
});

it('forwards owned node cancellation as a high-priority command without falling back to Sandbox', async () => {
  const f = fixture();
  const pair = await f.request('/api/nodes/pairing', 'POST', {});
  const registered = await f.request('/api/nodes/register', 'POST', { pairingToken: pair.body.token, name: 'Cancel laptop', platform: 'linux', arch: 'x64', capabilities: { runner: true } }, null);
  const bot = await f.request('/api/bots', 'POST', { name: 'Cancelable', model: 'test/model', nodeId: registered.body.node.id });
  const thread = await f.request('/api/threads', 'POST', { botId: bot.body.id, title: 'Cancel' });
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Long task', idempotencyKey: 'owned-cancel-1' });
  await f.alarm();
  const leased = await f.request(`/api/nodes/${registered.body.node.id}/jobs/poll`, 'GET', undefined, registered.body.nodeSecret);
  await f.request(`/api/nodes/${registered.body.node.id}/jobs/${leased.body.job.id}/result`, 'POST', { ok: true, result: { status: 'running', runId: run.body.id, events: [] } }, registered.body.nodeSecret);
  await f.request(`/api/runs/${run.body.id}/cancel`, 'POST', undefined);
  const command = await f.request(`/api/nodes/${registered.body.node.id}/jobs/poll`, 'GET', undefined, registered.body.nodeSecret);
  expect(command.body.job.payload).toMatchObject({ kind: 'runner.cancel', runId: run.body.id });
  expect(command.body.job.id).not.toBe(leased.body.job.id);
  expect(remote.submitted).toHaveLength(0);
});

it('surfaces owned-node approval progress and forwards the decision as a priority command', async () => {
  const f = fixture();
  const pair = await f.request('/api/nodes/pairing', 'POST', {});
  const registered = await f.request('/api/nodes/register', 'POST', { pairingToken: pair.body.token, name: 'Approval laptop', platform: 'windows', arch: 'x64', capabilities: { runner: true } }, null);
  const bot = await f.request('/api/bots', 'POST', { name: 'Approval bot', model: 'test/model', nodeId: registered.body.node.id });
  const thread = await f.request('/api/threads', 'POST', { botId: bot.body.id, title: 'Approval' });
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Approve this', idempotencyKey: 'owned-approval-1' });
  await f.alarm();
  const leased = await f.request(`/api/nodes/${registered.body.node.id}/jobs/poll`, 'GET', undefined, registered.body.nodeSecret);
  await f.request(`/api/nodes/${registered.body.node.id}/jobs/${leased.body.job.id}/progress`, 'POST', { result: { status: 'waiting_approval', runId: run.body.id, events: [{ seq: 1, type: 'approval.requested', data: { requestId: 'owned-permission', title: 'Run command' } }] } }, registered.body.nodeSecret);
  await f.alarm();
  expect((await f.request(`/api/runs/${run.body.id}`)).body.pendingApproval.requestId).toBe('owned-permission');
  await f.request(`/api/runs/${run.body.id}/approval`, 'POST', { requestId: 'owned-permission', decision: 'approve' });
  const command = await f.request(`/api/nodes/${registered.body.node.id}/jobs/poll`, 'GET', undefined, registered.body.nodeSecret);
  expect(command.body.job.payload).toMatchObject({ kind: 'runner.approval', runId: run.body.id, requestId: 'owned-permission', decision: 'approve' });
  await f.request(`/api/nodes/${registered.body.node.id}/jobs/${command.body.job.id}/result`, 'POST', { ok: true, result: { status: 'running' } }, registered.body.nodeSecret);
  await f.alarm();
  expect((await f.request(`/api/runs/${run.body.id}`)).body.status).toBe('running');
  expect(remote.submitted).toHaveLength(0);
});

it('creates explicit cross-bot delegations with durable idempotency and feeds completed results back to the source', async () => {
  const f = fixture();
  const sourceBot = await f.request('/api/bots', 'POST', { name: 'Scout', instructions: 'Scout context.', model: 'test/model' });
  const targetBot = await f.request('/api/bots', 'POST', { name: 'Llama', instructions: 'Solve the delegated task.', model: 'test/model' });
  const sourceThread = await f.request('/api/threads', 'POST', { botId: sourceBot.body.id, title: 'Main investigation' });
  const input = { targetBotId: targetBot.body.id, prompt: 'Inspect the failing behavior and report the smallest fix.', idempotencyKey: 'delegation-scout-1' };
  const created = await f.request(`/api/threads/${sourceThread.body.id}/delegations`, 'POST', input);
  expect(created.status).toBe(202);
  expect(created.body).toMatchObject({ sourceBotId: sourceBot.body.id, sourceThreadId: sourceThread.body.id, targetBotId: targetBot.body.id, prompt: input.prompt, status: 'queued' });
  expect(created.body.targetThreadId).not.toBe(sourceThread.body.id);
  expect((await f.request(`/api/threads/${sourceThread.body.id}/delegations`)).body).toHaveLength(1);
  const duplicate = await f.request(`/api/threads/${sourceThread.body.id}/delegations`, 'POST', input);
  expect(duplicate.body.id).toBe(created.body.id);
  expect((await f.request(`/api/threads/${sourceThread.body.id}/delegations`, 'POST', { ...input, prompt: 'different' })).status).toBe(409);
  expect((await f.request(`/api/threads/${sourceThread.body.id}/delegations`, 'POST', { ...input, idempotencyKey: 'delegation-same-bot', targetBotId: sourceBot.body.id })).status).toBe(400);
  expect((await f.request(`/api/threads/${sourceThread.body.id}/delegations`, 'POST', { ...input, idempotencyKey: 'delegation-unknown', targetBotId: 'bot_missing' })).status).toBe(404);
  expect((await f.request(`/api/threads/${created.body.targetThreadId}/delegations`, 'POST', { targetBotId: sourceBot.body.id, prompt: 'Loop back', idempotencyKey: 'delegation-loop' })).status).toBe(400);
  await f.alarm();
  const targetRun = remote.submitted.find((item) => item.threadId === created.body.targetThreadId);
  expect(targetRun).toMatchObject({ threadId: created.body.targetThreadId, model: 'test/model', systemPrompt: expect.stringContaining('Solve the delegated task.') });
  const remoteTarget = remote.runs.get(created.body.targetRunId);
  remoteTarget.status = 'succeeded'; remoteTarget.final = 'The smallest fix is to guard the empty input.';
  await f.alarm();
  expect((await f.request(`/api/threads/${sourceThread.body.id}/delegations`)).body[0]).toMatchObject({ status: 'succeeded', result: 'The smallest fix is to guard the empty input.' });
  await f.request('/api/runs', 'POST', { threadId: sourceThread.body.id, prompt: 'Continue with the investigation.', idempotencyKey: 'source-after-delegation' });
  await f.alarm();
  expect(remote.submitted.at(-1).systemPrompt).toContain('Completed delegation results');
  expect(remote.submitted.at(-1).systemPrompt).toContain('The smallest fix is to guard the empty input.');
});

it('reconciles runner bot requests exactly once and resumes the source after the child finishes', async () => {
  const f = fixture();
  const source = await f.request('/api/bots', 'POST', { name: 'Source', model: 'test/model' });
  const target = await f.request('/api/bots', 'POST', { name: 'Target', model: 'test/model' });
  const thread = await f.request('/api/threads', 'POST', { botId: source.body.id, title: 'Tool handoff' });
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Investigate', idempotencyKey: 'tool-source' });
  await f.alarm();
  const remoteRun = remote.runs.get(run.body.id);
  remoteRun.delegationRequests = [{ id: 'request-1', targetBotId: target.body.id, prompt: 'Find the cause.' }];
  remoteRun.status = 'succeeded'; remoteRun.final = 'Queued peer work.';
  for (let i = 0; i < 5; i++) await f.alarm();
  expect((await f.request(`/api/threads/${thread.body.id}/delegations`)).body).toHaveLength(1);
  expect((await f.request('/api/state')).body.threads).toHaveLength(2);
  await f.alarm();
  const child = [...remote.runs.values()].find((item: any) => item.runId !== run.body.id)!;
  child.status = 'succeeded'; child.final = 'The cause is a missing guard.';
  for (let i = 0; i < 5; i++) await f.alarm();
  expect(remote.submitted.filter((item: any) => item.idempotencyKey === undefined && item.allowBotMessaging === false)).toHaveLength(1);
  expect(remote.submitted.at(-1)).toMatchObject({ allowBotMessaging: false });
  const before = remote.submitted.length;
  for (let i = 0; i < 5; i++) await f.alarm();
  expect(remote.submitted).toHaveLength(before);
});

it('reconciles bot creation requests into persisted bots and reports the result', async () => {
  const f = fixture();
  const source = await f.request('/api/bots', 'POST', { name: 'Architect', model: 'test/model' });
  const thread = await f.request('/api/threads', 'POST', { botId: source.body.id, title: 'Create a teammate' });
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Create a writer bot', idempotencyKey: 'tool-create-writer' });
  await f.alarm();
  const remoteRun = remote.runs.get(run.body.id);
  remoteRun.botCreationRequests = [{ id: 'create-1', name: 'Writer', instructions: 'Draft reports.', model: 'test/model', agent: '' }];
  remoteRun.status = 'succeeded'; remoteRun.final = 'Queued bot creation.';
  for (let i = 0; i < 4; i++) await f.alarm();
  const bots = (await f.request('/api/bots')).body;
  expect(bots.map((item: any) => item.name)).toContain('Writer');
  expect((await f.request('/api/state')).body.threads).toHaveLength(1);
  expect(remote.submitted.some((item: any) => item.allowBotMessaging === false && String(item.prompt).includes('Created Writer'))).toBe(true);
  for (let i = 0; i < 4; i++) await f.alarm();
  expect((await f.request('/api/bots')).body.filter((item: any) => item.name === 'Writer')).toHaveLength(1);
});

it('records invalid and ancestor bot requests without retrying or creating a loop', async () => {
  const f = fixture();
  const source = await f.request('/api/bots', 'POST', { name: 'Source', model: 'test/model' });
  const target = await f.request('/api/bots', 'POST', { name: 'Target', model: 'test/model' });
  const thread = await f.request('/api/threads', 'POST', { botId: source.body.id, title: 'Cycle check' });
  const run = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Delegate', idempotencyKey: 'cycle-source' });
  await f.alarm();
  const remoteRun = remote.runs.get(run.body.id);
  remoteRun.delegationRequests = [{ id: 'to-target', targetBotId: target.body.id, prompt: 'Try it.' }, { id: 'bad', targetBotId: source.body.id, prompt: 'Self.' }];
  remoteRun.status = 'succeeded';
  await f.alarm();
  await f.alarm();
  const child = [...remote.runs.values()].find((item: any) => item.runId !== run.body.id)!;
  child.delegationRequests = [{ id: 'back-to-source', targetBotId: source.body.id, prompt: 'Loop.' }];
  child.status = 'succeeded';
  await f.alarm();
  const delegations = (await f.request(`/api/threads/${thread.body.id}/delegations`)).body;
  expect(delegations).toHaveLength(1);
  const submitted = remote.submitted.length;
  for (let i = 0; i < 5; i++) await f.alarm();
  expect(remote.submitted.length).toBe(submitted + 1);
  for (let i = 0; i < 5; i++) await f.alarm();
  expect(remote.submitted.length).toBe(submitted + 1);
});

it('waits for nested bot continuations and uses the nested final answer', async () => {
  const f = fixture();
  const a = await f.request('/api/bots', 'POST', { name: 'A', model: 'test/model' });
  const b = await f.request('/api/bots', 'POST', { name: 'B', model: 'test/model' });
  const c = await f.request('/api/bots', 'POST', { name: 'C', model: 'test/model' });
  const thread = await f.request('/api/threads', 'POST', { botId: a.body.id, title: 'Nested' });
  const root = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Start', idempotencyKey: 'nested-a' });
  await f.alarm();
  const ar = remote.runs.get(root.body.id); ar.delegationRequests = [{ id: 'a-b', targetBotId: b.body.id, prompt: 'Ask C.' }]; ar.status = 'succeeded';
  for (let i = 0; i < 5; i++) await f.alarm();
  const bDelegation = (await f.request(`/api/threads/${thread.body.id}/delegations`)).body[0];
  const br = remote.runs.get(bDelegation.targetRunId); br.delegationRequests = [{ id: 'b-c', targetBotId: c.body.id, prompt: 'Find answer.' }]; br.status = 'succeeded'; br.final = 'B intermediate';
  for (let i = 0; i < 5; i++) await f.alarm();
  const all = [...remote.runs.values()];
  const cr = all.find((item: any) => item.runId !== root.body.id && item.runId !== bDelegation.targetRunId && item.allowBotMessaging !== false)!;
  cr.status = 'succeeded'; cr.final = 'C final answer';
  for (let i = 0; i < 5; i++) await f.alarm();
  const bInput = remote.submitted.find((item: any) => item.allowBotMessaging === false && item.threadId === bDelegation.targetThreadId)!;
  const bContinuation = bInput && remote.runs.get(bInput.runId);
  expect(bContinuation).toBeDefined();
  expect(remote.submitted.some((item: any) => item.allowBotMessaging === false && item.threadId === thread.body.id)).toBe(false);
  bContinuation.status = 'succeeded'; bContinuation.final = 'B completed answer';
  for (let i = 0; i < 5; i++) await f.alarm();
  const aContinuation = remote.submitted.find((item: any) => item.allowBotMessaging === false && item.threadId === thread.body.id)!;
  expect(aContinuation).toMatchObject({ allowBotMessaging: false });
  expect(aContinuation.prompt).toContain('B completed answer');
  expect(aContinuation.prompt).not.toContain('B intermediate');
});

it('copies Telegram routing metadata to an internal continuation as a fresh pending receipt', async () => {
  const f = fixture();
  const source = await f.request('/api/bots', 'POST', { name: 'TG source', model: 'test/model' });
  const target = await f.request('/api/bots', 'POST', { name: 'TG target', model: 'test/model' });
  const thread = await f.request('/api/threads', 'POST', { botId: source.body.id, title: 'TG' });
  const root = await f.request('/api/runs', 'POST', { threadId: thread.body.id, prompt: 'Start', idempotencyKey: 'tg-root' });
  await f.alarm();
  f.db.prepare("INSERT INTO telegram_run_deliveries (run_id,bot_id,chat_id,telegram_user_id,created_at,status) VALUES (?,?,?,?,?,?)").run(root.body.id, source.body.id, 'chat-7', 'user-9', new Date().toISOString(), 'sent');
  const rr = remote.runs.get(root.body.id); rr.delegationRequests = [{ id: 'tg-1', targetBotId: target.body.id, prompt: 'Reply.' }]; rr.status = 'succeeded';
  for (let i = 0; i < 5; i++) await f.alarm();
  const child = [...remote.runs.values()].find((item: any) => item.runId !== root.body.id)!; child.status = 'succeeded'; child.final = 'Done';
  await f.alarm(); await f.alarm();
  const continuation = remote.submitted.find((item: any) => item.allowBotMessaging === false)!;
  const receipt = f.db.prepare('SELECT * FROM telegram_run_deliveries WHERE run_id=?').get(continuation.runId) as any;
  expect(receipt).toMatchObject({ bot_id: source.body.id, chat_id: 'chat-7', telegram_user_id: 'user-9', status: 'pending' });
});

it('Telegram /new preserves bot configuration and binds subsequent messages to the new thread', async () => {
  const f=fixture(); const {bot,thread}=await f.create();
  const original=globalThis.fetch;
  const calls:any[]=[];
  globalThis.fetch=vi.fn(async (_url:any,init?:RequestInit) => {
    const method=String(_url).split('/').at(-1); calls.push({method,input:JSON.parse(String(init?.body??'{}'))});
    return Response.json({ok:true,result:method==='getMe'?{id:123,is_bot:true,username:'test_bot',first_name:'Test'}:method==='getUpdates'?[]:true});
  }) as any;
  try {
    expect((await f.request(`/api/bots/${bot.id}/telegram/configure`,'POST',{token:'123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',transport:'polling'})).status).toBe(200);
    const skill=await f.request('/api/skills','POST',{name:'Research',instructions:'Cite primary sources.'});
    await f.request(`/api/bots/${bot.id}/skills`,'PUT',{skillIds:[skill.body.id]});
    f.db.prepare('INSERT INTO telegram_chat_bindings VALUES (?,?,?,?,?,?)').run(bot.id,'77','77','owner',thread.id,new Date().toISOString());
    const config=f.db.prepare('SELECT webhook_secret FROM telegram_bot_configs WHERE bot_id=?').get(bot.id) as any;
    const send=async (id:number,text:string) => {
      const response=await worker.fetch(new Request(`https://bot.test/api/integrations/telegram/webhook/${bot.id}`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':config.webhook_secret},body:JSON.stringify({update_id:id,message:{message_id:id,from:{id:77},chat:{id:77,type:'private'},text}})}),f.env);
      expect(response.status).toBe(200); return response.json();
    };
    await send(101,'/new Fresh research'); await send(101,'/new Fresh research');
    const binding=f.db.prepare('SELECT thread_id FROM telegram_chat_bindings WHERE bot_id=?').get(bot.id) as any;
    expect(binding.thread_id).not.toBe(thread.id);
    expect(f.db.prepare("SELECT COUNT(*) n FROM threads WHERE title='Fresh research'").get()).toMatchObject({n:1});
    await send(102,'Read this carefully'); await f.alarm();
    expect(remote.submitted.at(-1)).toMatchObject({model:bot.model,prompt:'Read this carefully'});
    expect(remote.submitted.at(-1).systemPrompt).toContain('Your name is Builder');
    expect(remote.submitted.at(-1).systemPrompt).toContain('Check your work.');
    expect(remote.submitted.at(-1).systemPrompt).toContain('Cite primary sources.');
    expect(calls.find(c=>c.method==='setMyCommands').input.commands.some((c:any)=>c.command==='new')).toBe(true);
  } finally { globalThis.fetch=original; }
});

it('lets a fresh user request message a previous source bot without inheriting the old loop ancestry', async () => {
  const f=fixture();
  const a=(await f.request('/api/bots','POST',{name:'A',model:'test/model'})).body;
  const b=(await f.request('/api/bots','POST',{name:'B',model:'test/model'})).body;
  const thread=(await f.request('/api/threads','POST',{botId:a.id,title:'A conversation'})).body;
  const handoff=(await f.request(`/api/threads/${thread.id}/delegations`,'POST',{targetBotId:b.id,prompt:'Introduce yourself',idempotencyKey:'initial-a-b'})).body;
  await f.alarm(); remote.runs.get(handoff.targetRunId).status='succeeded'; await f.alarm();
  const fresh=(await f.request('/api/runs','POST',{threadId:handoff.targetThreadId,prompt:'Tell A hello from the user',idempotencyKey:'fresh-b-a'})).body;
  await f.alarm();
  const run=remote.runs.get(fresh.id); run.status='succeeded'; run.delegationRequests=[{id:'fresh-reverse',targetBotId:a.id,prompt:'Hello from the user'}];
  await f.alarm();
  const replies=(await f.request(`/api/threads/${handoff.targetThreadId}/delegations`)).body;
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({targetBotId:a.id,prompt:'Hello from the user'});
});

it('delivers Telegram activity from native messages before a formatted final answer', async()=>{
 const f=fixture();const {bot,thread}=await f.create();const original=globalThis.fetch;const calls:any[]=[];
 globalThis.fetch=vi.fn(async(url:any,init?:RequestInit)=>{
  const method=String(url).split('/').at(-1);calls.push({method,input:JSON.parse(String(init?.body??'{}'))});
  return Response.json({ok:true,result:method==='getMe'?{id:123,is_bot:true,username:'test_bot',first_name:'Test'}:method==='getUpdates'?[]:method==='sendMessage'?{message_id:991}:true});
 }) as any;
 try {
  await f.request(`/api/bots/${bot.id}/telegram/configure`,'POST',{token:'123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',transport:'polling'});
  f.db.prepare('INSERT INTO telegram_chat_bindings VALUES (?,?,?,?,?,?)').run(bot.id,'77','77','owner',thread.id,new Date().toISOString());
  const run=await f.request('/api/runs','POST',{threadId:thread.id,prompt:'Check the page',idempotencyKey:'tg-activity'});
  f.db.prepare('INSERT INTO telegram_run_deliveries (run_id,bot_id,chat_id,telegram_user_id,created_at,status) VALUES (?,?,?,?,?,?)').run(run.body.id,bot.id,'77','77',new Date().toISOString(),'pending');
  remote.messages=[{type:'assistant',time:{created:Date.now()+100},content:[{type:'text',text:'Checking the page now.'},{type:'tool',name:'computer_browser_browser_snapshot',state:{status:'running'}}]}];
  await f.alarm();
  // Advance the durable throttle without sleeping; the next alarm must edit the same message.
  f.db.prepare('UPDATE telegram_run_activities SET last_sent_at=0').run();
  await f.alarm();
  f.db.prepare('UPDATE telegram_run_activities SET last_sent_at=0').run();
  await f.alarm();
  expect(calls.filter(c=>c.method==='editMessageText').map(c=>c.input.text)).toEqual(expect.arrayContaining([expect.stringContaining('Inspecting a page')]));
  const active=remote.runs.get(run.body.id);active.status='succeeded';active.final='**Done** — page verified.';
  await f.alarm();
  expect(calls.some(c=>c.method==='sendMessage' && c.input.parse_mode==='HTML' && c.input.text.includes('<b>Done</b>'))).toBe(true);
 }finally {globalThis.fetch=original;}
});

it('returns a chronological activity tail and explains interrupted runner recovery', async()=>{
 const f=fixture();const {thread}=await f.create();const run=(await f.request('/api/runs','POST',{threadId:thread.id,prompt:'Inspect',idempotencyKey:'tail-test'})).body;
 const insert=f.db.prepare('INSERT INTO events (id,run_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?,?)');
 for(let i=2;i<=70;i++)insert.run(`tail-${i}`,run.id,i,'runner.session.reasoning.delta','{}',new Date().toISOString());
 insert.run('recovery-tail',run.id,71,'runner.recovery.needs_review','{}',new Date().toISOString());
 f.db.prepare("UPDATE runs SET status='needs_review' WHERE id=?").run(run.id);
 const state=(await f.request('/api/state')).body;expect(state.runs[0].events).toHaveLength(30);
 expect(state.runs[0].events.map((e:any)=>e.sequence)).toEqual(Array.from({length:30},(_,i)=>42+i));
 expect(state.runs[0].error).toContain('restarted before completion could be confirmed');
});
