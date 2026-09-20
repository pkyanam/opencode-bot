import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OpenCode2Runtime, eventText, eventType } from "../packages/runtime-opencode2/src/client.mjs";
import { dispatchArtifactRequest } from './artifacts.mjs';
import { DesktopController } from './desktop.mjs';
import { createTerminalRoutes } from './terminal-routes.mjs';
import { defaultCliCommand } from './terminal.mjs';

const port = Number(process.env.RUNNER_PORT ?? process.env.PORT ?? 8787);
const token = process.env.RUNNER_TOKEN;
const isEntrypoint = process.argv[1]?.endsWith("/runner/server.mjs") || process.argv[1]?.endsWith("\\runner\\server.mjs");
if (!token && isEntrypoint && process.env.NODE_ENV !== "test") throw new Error("RUNNER_TOKEN is required");

export class RunStore {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.stateDir = options.stateDir;
    this.instanceId = options.instanceId ?? (this.stateDir ? loadStableInstanceId(options.instanceIdFile ?? path.join(this.stateDir, '../../computer-instance-id')) : randomUUID());
    this.paused = false;
    this.runtimeOps = 0;
    this.runtimeIdle = [];
    this.runs = new Map();
    if (this.stateDir) this.load();
  }

  get(id) { return this.runs.get(id); }

  /** Serialize runtime users with checkpoint teardown. A request that has not
   * entered this gate by the time quiescing begins is rejected, so it cannot
   * restart OpenCode/Chromium while the workspace is being archived. */
  async withRuntime(fn) {
    if (this.paused) throw httpError(409, "runner is quiesced");
    this.runtimeOps += 1;
    try { return await fn(); }
    finally {
      this.runtimeOps -= 1;
      if (this.runtimeOps === 0) {
        for (const resolve of this.runtimeIdle.splice(0)) resolve();
      }
    }
  }

  async waitForRuntimeIdle() {
    if (this.runtimeOps === 0) return;
    await new Promise((resolve) => this.runtimeIdle.push(resolve));
  }

  async start(input) {
    if (this.paused) throw httpError(409, "runner is quiesced");
    if (this.terminalRegistry?.active()) throw httpError(409, "computer has an active terminal controller");
    const commandPrompt = input?.command?.name ? `/${input.command.name} ${input.command.text ?? ""}`.trim() : "";
    const hasAction = Boolean(input?.sessionAction?.name);
    if (!input?.runId || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.runId) || (typeof input.prompt !== "string" || !input.prompt.trim()) && !commandPrompt && !hasAction) throw httpError(400, "runId and non-empty prompt, native command, or session action are required");
    if (this.runs.has(input.runId)) {
      const existing = this.runs.get(input.runId);
      if (existing.prompt !== (input.prompt ?? commandPrompt) || JSON.stringify(existing.command??null)!==JSON.stringify(input.command??null) || JSON.stringify(existing.sessionAction??null)!==JSON.stringify(input.sessionAction??null)) throw httpError(409, 'runId is already bound to another input');
      return this.public(existing);
    }
    if ([...this.runs.values()].some(run => !isTerminal(run.status))) throw httpError(409, 'computer already has an active run');
    const run = { id: input.runId, prompt: input.prompt ?? commandPrompt, command: input.command, sessionAction: input.sessionAction, status: "provisioning", sessionId: input.sessionId, events: [], final: "", cancelRequested: false, startedAt: new Date().toISOString() };
    this.runs.set(run.id, run); this.persist(run);
    void this.execute(run, input);
    return this.public(run);
  }

  async execute(run, input) {
    const controller = new AbortController();
    let watcher;
    try {
      run.status = "running";
      this.persist(run);
      // Always re-enter the runtime for an existing session so model/agent
      // changes are applied through session.switchModel/switchAgent. The
      // persisted session id is still authoritative for prompt continuity.
      if (run.sessionId) {
        await this.runtime.createSession({ sessionId: run.sessionId, model: input.model, agent: input.agent, title: input.title, directory: input.directory });
      } else {
        run.sessionId = await this.runtime.createSession({ sessionId: input.sessionId, model: input.model, agent: input.agent, title: input.title, directory: input.directory });
      }
      this.emit(run, "session.created", { sessionId: run.sessionId });
      if (run.cancelRequested) { run.status = 'cancelled'; return; }
      if (this.runtime.instructions) await this.runtime.instructions(run.sessionId,input.systemPrompt??'');
      const before = new Set((await this.runtime.messages?.(run.sessionId) ?? []).map(message => message.id));
      const events = this.runtime.events?.(controller.signal);
      watcher = events ? this.watch(run, events) : Promise.resolve();
      if (input.sessionAction) {
        const actionName = String(input.sessionAction.name ?? "");
        if (!/^[A-Za-z0-9._:-]{1,80}$/.test(actionName)) throw httpError(400, "session action name is invalid");
        if (!this.runtime.nativeAction) throw new Error("native session actions are unavailable");
        const actionResult = await this.runtime.nativeAction(run.sessionId, actionName, input.sessionAction.input ?? {});
        run.actionResult = actionResult ?? null;
        this.emit(run, "session.action.completed", { action: actionName, result: actionResult ?? null });
      } else if (input.command) {
        if (!input.command.name || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.command.name)) throw httpError(400, "command name is invalid");
        if (!this.runtime.command) throw new Error("native command execution is unavailable");
        await this.runtime.command(run.sessionId, input.command.name, input.command.text ?? "");
      } else {
        await this.runtime.prompt(run.sessionId, !this.runtime.instructions && input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt);
      }
      if (input.sessionAction) {
        // Native actions such as compact/revert may not create an assistant
        // message. Their explicit action result is the receipt.
        if (input.sessionAction.name === 'compact' && this.runtime.wait) await this.runtime.wait(run.sessionId, AbortSignal.timeout(30 * 60 * 1000));
      } else if (this.runtime.wait) {
        await this.runtime.wait(run.sessionId, AbortSignal.timeout(30 * 60 * 1000));
        const messages = (await this.runtime.messages(run.sessionId)).filter(message => !before.has(message.id) && message.type === 'assistant').sort((a,b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
        run.final = messages.flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n\n');
        if (run.runtimeOutcome === 'session.execution.failed' || messages.some(message => message.error || message.finish === 'error')) throw new Error(messages.find(message => message.error)?.error?.message ?? messages.find(message => typeof message.error === 'string')?.error ?? 'OpenCode reported an execution error');
        if (!messages.length && !run.cancelRequested) throw new Error('Execution ended without an assistant result');
      } else await watcher;
      if (!isTerminal(run.status)) {
        run.status = run.cancelRequested ? "cancelled" : "succeeded";
        this.emit(run, run.status, run.final ? { text: run.final } : {});
      }
    } catch (error) {
      run.status = run.cancelRequested ? "cancelled" : (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'needs_review' : "failed";
      if (run.status === 'needs_review' && run.sessionId) await this.runtime.interrupt(run.sessionId).catch(() => {});
      this.emit(run, "error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      controller.abort();
      run.finishedAt = new Date().toISOString();
      this.persist(run);
    }
  }

  async watch(run, iterable) {
    try {
      for await (const event of iterable) {
        const eventData = event?.properties ?? event?.data ?? {};
        if (eventData.sessionID !== run.sessionId) continue;
        const type = eventType(event);
        const text = eventText(event);
        if (text) run.final += text;
        if (type === 'permission.asked') {
          run.status = 'waiting_approval';
          this.emit(run, 'approval.requested', { ...eventData, requestId: eventData.id });
        } else this.emit(run, type, eventData);
        if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(type)) {
          run.runtimeOutcome = type;
          if (!this.runtime.wait) run.status = type.endsWith('succeeded') ? 'succeeded' : type.endsWith('failed') ? 'failed' : 'cancelled';
          break;
        }
      }
    } catch (error) {
      if (!isTerminal(run.status)) this.emit(run, "stream.error", { message: error instanceof Error ? error.message : String(error) });
      if (!this.runtime.wait && !run.cancelRequested) run.status = 'needs_review';
    }
  }

  async cancel(run) {
    if (!run) throw httpError(404, "run not found");
    run.cancelRequested = true;
    if (!isTerminal(run.status) && run.sessionId) await this.runtime.interrupt(run.sessionId);
    if (!isTerminal(run.status)) { run.status = "cancelled"; this.emit(run, "cancelled", {}); }
    return this.public(run);
  }

  async approval(run, body) {
    if (!run) throw httpError(404, "run not found");
    const decision = { approve: "once", deny: "reject", once: "once", always: "always", reject: "reject" }[body?.decision];
    if (!run.sessionId || !body?.requestId || !decision) throw httpError(400, "requestId and decision (approve or deny) are required");
    await this.runtime.replyApproval(run.sessionId, body.requestId, decision, body.message);
    if (run.status === 'waiting_approval') run.status = 'running';
    this.emit(run, "approval.replied", { requestId: body.requestId, decision: body.decision, upstreamDecision: decision });
    return this.public(run);
  }

  async refresh(run) {
    if (!run || isTerminal(run.status) || !run.sessionId || !this.runtime.permissions) return;
    for (const permission of await this.runtime.permissions(run.sessionId)) {
      if (run.events.some(event => event.type === 'approval.requested' && event.data.requestId === permission.id)) continue;
      run.status = 'waiting_approval';
      this.emit(run, 'approval.requested', { ...permission, requestId: permission.id });
    }
  }

  async checkpoint() {
    this.paused = true;
    await this.waitForRuntimeIdle();
    if (this.terminalRegistry?.active()) { this.paused = false; throw httpError(409, "cannot checkpoint while terminal controller is active"); }
    const active = [...this.runs.values()].filter((run) => !isTerminal(run.status) && run.status !== "needs_review");
    if (active.length) { this.paused = false; throw httpError(409, "cannot checkpoint while runs are active"); }
    if (this.runtime.stop) await this.runtime.stop();
    const checkpoint = { version: 1, createdAt: new Date().toISOString(), runs: [...this.runs.values()].map((run) => ({ runId: run.id, status: run.status, sessionId: run.sessionId, eventSeq: run.events.length })) };
    if (this.stateDir) fs.writeFileSync(path.join(this.stateDir, "checkpoint.json.tmp"), JSON.stringify(checkpoint));
    if (this.stateDir) fs.renameSync(path.join(this.stateDir, "checkpoint.json.tmp"), path.join(this.stateDir, "checkpoint.json"));
    return checkpoint;
  }

  async resume() {
    if (!this.stateDir) { this.paused = false; return { resumed: true, checkpoint: null }; }
    const filename = path.join(this.stateDir, "checkpoint.json");
    this.runs.clear(); this.load();
    this.paused = false;
    return { resumed: true, checkpoint: fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : null };
  }

  emit(run, type, data) { run.events.push({ seq: run.events.length + 1, type, data }); this.persist(run); }
  public(run) { return { runId: run.id, status: run.status, sessionId: run.sessionId, events: run.events, final: run.final, error: run.status === 'failed' ? run.events.findLast(event => event.type === 'error')?.data?.message : undefined, startedAt: run.startedAt, finishedAt: run.finishedAt }; }
  load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    for (const file of fs.readdirSync(this.stateDir).filter((name) => name.endsWith(".json"))) {
      try {
        if (file === "checkpoint.json") continue;
        const run = JSON.parse(fs.readFileSync(path.join(this.stateDir, file), "utf8"));
        if (!run.id) continue;
        if (run.status && !isTerminal(run.status)) { run.status = "needs_review"; run.events ??= []; run.events.push({ seq: run.events.length + 1, type: "recovery.needs_review", data: { reason: "runner restarted before terminal receipt" } }); }
        this.runs.set(run.id, run);
        if (run.status === "needs_review") this.persist(run);
      } catch { /* ignore an incomplete temporary file */ }
    }
  }
  persist(run) {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    const target = path.join(this.stateDir, `${encodeURIComponent(run.id)}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(run));
    fs.renameSync(temporary, target);
  }
}

function loadStableInstanceId(filename) {
  try {
    const existing = fs.readFileSync(filename, "utf8").trim();
    if (existing) return existing;
  } catch { /* first boot or an ephemeral image */ }
  const value = randomUUID();
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${value}\n`, { flag: "wx" });
    fs.renameSync(temporary, filename);
  } catch {
    try { return fs.readFileSync(filename, "utf8").trim() || value; } catch { return value; }
  }
  return value;
}

export function createServer({ store, authToken = token, workspace = process.env.WORKSPACE_DIRECTORY ?? '/workspace/shared', desktop, terminalRoutes } = {}) {
  if (!authToken) throw new Error('RUNNER_TOKEN is required');
  const terminals = terminalRoutes ?? createTerminalRoutes({
    resolveConnection: async (sessionId) => {
      if (store.paused || [...store.runs.values()].some(run=>!isTerminal(run.status))) throw httpError(409,'Finish the active task before opening OpenCode.');
      const runtime = store.runtime;
      if (!runtime?.start) throw httpError(503, "OpenCode runtime is unavailable");
      await store.withRuntime(async () => {
        await runtime.start();
        if (!runtime.client?.session?.get) throw httpError(503, "OpenCode session API is unavailable");
        await runtime.client.session.get({ sessionID: sessionId });
      });
      const endpoint = runtime.endpoint;
      if (!endpoint?.url) throw httpError(503, "OpenCode runtime endpoint is unavailable");
      const authEnv = endpoint.auth
        ? { OPENCODE_SERVER_USERNAME: endpoint.auth.username, OPENCODE_SERVER_PASSWORD: endpoint.auth.password }
        : endpoint.password
          ? { OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: endpoint.password }
          : {};
      return { serverUrl: endpoint.url, sessionId, authEnv, cwd: workspace, command: defaultCliCommand() };
    },
  });
  store.terminalRegistry = terminals.registry;
  return http.createServer(async (req, res) => {
    try {
      if (req.url === "/health" && req.method === "GET") return json(res, 200, { ok: true, service: "opencode2-runner", instanceId: store.instanceId });
      if (authToken && req.headers.authorization !== `Bearer ${authToken}`) return json(res, 401, { error: "unauthorized" });
      if (new URL(req.url, 'http://runner').pathname.startsWith('/files')) {
        if (store.paused && req.method !== 'GET') return json(res, 409, { error: 'runner is quiesced' });
        if (await dispatchArtifactRequest(req, res, workspace)) return;
      }
      if (await terminals.handle(req, res)) return;
      if (req.url === "/checkpoint/quiesce" && req.method === "POST") return json(res, 200, await store.checkpoint());
      if (req.url === "/checkpoint/resume" && req.method === "POST") return json(res, 200, await store.resume());
      if (req.url === "/checkpoint/state" && req.method === "GET") return json(res, 200, { instanceId: store.instanceId, quiesced: store.paused });
      // Resume is handled above; every other mutating route is fenced while
      // the filesystem is quiesced so cancel/approval cannot restart runtime.
      if (store.paused && req.method !== "GET") return json(res, 409, { error: "runner is quiesced" });
      if (desktop && req.method === "GET" && new URL(req.url, 'http://runner').pathname === "/desktop/status") return json(res, 200, desktop.status());
      if (desktop && req.method === "GET" && ["/desktop/stream", "/preview"].includes(new URL(req.url, 'http://runner').pathname)) {
        if (store.paused) return json(res, 409, { error: "runner is quiesced" });
        const stream = await desktop.stream();
        res.writeHead(stream.status, Object.fromEntries(stream.headers));
        const reader = stream.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => undefined); };
        res.once('close', cancel);
        try {
          while (!res.destroyed) {
            const item = await reader.read();
            if (item.done || res.destroyed) break;
            if (!res.write(Buffer.from(item.value))) {
              await new Promise(resolve => {
                const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                res.once('drain', done); res.once('close', done);
              });
            }
          }
        } finally {
          res.off('close', cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          if (!res.destroyed) res.end();
        }
        return;
      }
      if (new URL(req.url, 'http://runner').pathname === "/catalog" && req.method === "GET") {
        if (!store.runtime.catalog) return json(res, 501, { error: "catalog is unavailable" });
        return json(res, 200, await store.withRuntime(() => store.runtime.catalog(new URL(req.url, 'http://runner').searchParams.get("directory") ?? workspace)));
      }
      if (req.url === '/sessions' && req.method === 'POST') {
        if (store.paused || store.terminalRegistry?.active() || [...store.runs.values()].some(run => !isTerminal(run.status))) return json(res, 409, { error: 'computer is busy' });
        const input = await readJson(req);
        const sessionId = await store.withRuntime(async () => {
          const created = await store.runtime.createSession({sessionId:input.sessionId, title: input.title, model: input.model, agent: input.agent, directory: workspace });
          if (store.runtime.instructions) await store.runtime.instructions(created,input.systemPrompt??'');
          return created;
        });
        return json(res, 201, { sessionId });
      }
      const sessionMessages = new URL(req.url, 'http://runner').pathname.match(/^\/sessions\/([A-Za-z0-9._:-]{1,160})\/messages$/);
      if (sessionMessages && req.method === "GET") {
        if (!store.runtime.messages) return json(res, 501, { error: "session messages are unavailable" });
        const messages = await store.withRuntime(() => store.runtime.messages(sessionMessages[1]));
        return json(res, 200, { sessionId: sessionMessages[1], messages: Array.isArray(messages) ? messages.slice().sort((a,b) => (b.time?.created ?? 0) - (a.time?.created ?? 0)).slice(0,200) : [] });
      }
      const match = new URL(req.url, "http://runner").pathname.match(/^\/runs(?:\/([^/]+)(?:\/(cancel|approval))?)?$/);
      if (!match) return json(res, 404, { error: "not found" });
      const body = await readJson(req);
      if (req.method === "POST" && !match[1]) return json(res, 202, await store.start(body));
      if (req.method === "GET" && match[1]) {
        const run = store.get(match[1]);
        if (run && !store.paused) await store.withRuntime(() => store.refresh(run));
        return run ? json(res, 200, store.public(run)) : json(res, 404, { error: "run not found" });
      }
      if (req.method === "POST" && match[2] === "approval") return json(res, 200, await store.approval(store.get(match[1]), body));
      return json(res, 405, { error: "method not allowed" });
    } catch (error) { const status = error.statusCode ?? 500; json(res, status, { error: error.message ?? String(error) }); }
  });
}

function isTerminal(status) { return ["succeeded", "failed", "cancelled", "needs_review"].includes(status); }
function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  if (!req.headers["content-length"] && req.method !== "POST") return {};
  let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw httpError(413, "request body too large"); }
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw httpError(400, "invalid JSON"); }
}

if (isEntrypoint && process.env.NODE_ENV !== "test") {
  const root = process.env.RUNTIME_ROOT ?? "/workspace/state";
  const desktop = process.env.OPENCODE_BOT_DESKTOP === "0" ? undefined : new DesktopController();
  const runtime = new OpenCode2Runtime({ root, directory: process.env.WORKSPACE_DIRECTORY ?? "/workspace/shared", desktop });
  createServer({ store: new RunStore(runtime, { stateDir: path.join(root, "runs") }), desktop }).listen(port, process.env.RUNNER_HOST ?? "127.0.0.1", () => console.log(`runner listening on ${port}`));
}
