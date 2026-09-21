import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode2Runtime, eventText, eventType } from "../packages/runtime-opencode2/src/client.mjs";
import { dispatchArtifactRequest } from './artifacts.mjs';
import { DesktopController } from './desktop.mjs';
import { createTerminalRoutes } from './terminal-routes.mjs';
import { createPluginRoutes } from "./plugin-routes.mjs";
import { createExtensionRoutes } from './extension-routes.mjs';
import { defaultCliCommand } from './terminal.mjs';

const port = Number(process.env.RUNNER_PORT ?? process.env.PORT ?? 8787);
const token = process.env.RUNNER_TOKEN;
const isEntrypoint = process.argv[1]?.endsWith("/runner/server.mjs") || process.argv[1]?.endsWith("\\runner\\server.mjs");
if (!token && isEntrypoint && process.env.NODE_ENV !== "test") throw new Error("RUNNER_TOKEN is required");
function errorMessage(error, seen = new Set()) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (!error || typeof error !== 'object' || seen.has(error)) return String(error ?? 'Unknown error');
  seen.add(error);
  for (const key of ['message', 'error', 'reason', 'detail', 'cause']) {
    const value = error[key];
    if (value === undefined || value === error) continue;
    const nested = errorMessage(value, seen);
    if (nested && nested !== '[object Object]') return nested;
  }
  try { return JSON.stringify(error); } catch { return '[object Object]'; }
}
const isTransientTransportError = (error) => /transport|connection|socket|network|fetch|econnreset|eof/i.test(errorMessage(error));

export class RunStore {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.stateDir = options.stateDir;
    this.instanceId = options.instanceId ?? (this.stateDir ? loadStableInstanceId(options.instanceIdFile ?? path.join(this.stateDir, '../../computer-instance-id')) : randomUUID());
    this.paused = false;
    this.configuring = false;
    this.runtimeOps = 0;
    this.nativeWaitTimeoutMs = options.nativeWaitTimeoutMs ?? 5 * 60 * 1000;
    this.runtimeIdle = [];
    this.ownershipUncertain = false;
    this.runs = new Map();
    this.recoverySessions = new Set();
    if (this.stateDir) this.load();
  }

  get(id) { return this.runs.get(id); }

  /** Serialize runtime users with checkpoint teardown. A request that has not
   * entered this gate by the time quiescing begins is rejected, so it cannot
   * restart OpenCode/Chromium while the workspace is being archived. */
  async recoverNativeOwnership() {
    if (!this.recoverySessions.size) return;
    if (this.recoveringOwnership) return this.recoveringOwnership;
    this.recoveringOwnership = (async () => {
      try {
        for (const sessionId of this.recoverySessions) {
          let timer;
          try { await Promise.race([this.runtime.interrupt(sessionId), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("native interruption timed out")), 15000); })]); }
          finally { clearTimeout(timer); }
        }
      } catch (error) {
        if (!this.runtime.stop) { this.ownershipUncertain = true; throw error; }
        try { await this.runtime.stop(); } catch (stopError) { this.ownershipUncertain = true; throw stopError; }
      }
      for (const run of this.runs.values()) {
        if (this.recoverySessions.has(run.sessionId)) { run.ownershipStopped = true; run.ownershipUncertain = false; this.persist(run); }
      }
      this.recoverySessions.clear();
      this.ownershipUncertain = false;
    })();
    try { await this.recoveringOwnership; } finally { this.recoveringOwnership = undefined; }
  }

  async withRuntime(fn) {
    await this.recoverNativeOwnership();
    if (this.paused || this.configuring) throw httpError(409, "computer settings or checkpoint are being updated");
    this.runtimeOps += 1;
    try { return await fn(); }
    finally {
      this.runtimeOps -= 1;
      if (this.runtimeOps === 0) {
        for (const resolve of this.runtimeIdle.splice(0)) resolve();
      }
    }
  }

  async updateConfiguration(fn) {
    await this.recoverNativeOwnership();
    if (this.paused || this.configuring || this.ownershipUncertain || this.terminalRegistry?.active() || [...this.runs.values()].some(run=>!isTerminal(run.status))) throw httpError(409,'Finish active work before changing computer settings');
    this.configuring = true;
    try { await this.waitForRuntimeIdle(); return await fn(); }
    finally { this.configuring = false; }
  }

  async waitForRuntimeIdle() {
    if (this.runtimeOps === 0) return;
    await new Promise((resolve) => this.runtimeIdle.push(resolve));
  }

  forgetSessionRuns(sessionId) {
    if (!sessionId) return;
    for (const [id, run] of this.runs) {
      if (run.sessionId !== sessionId) continue;
      if (this.stateDir) {
        const filename = path.join(this.stateDir, `${encodeURIComponent(id)}.json`);
        fs.rmSync(filename, { force: true });
      }
      this.runs.delete(id);
    }
  }

  async start(input) {
    await this.recoverNativeOwnership();
    if (this.paused || this.configuring || this.ownershipUncertain) throw httpError(409, "computer settings or checkpoint are being updated");
    if (this.terminalRegistry?.active()) throw httpError(409, "computer has an active terminal controller");
    const commandPrompt = input?.command?.name ? `/${input.command.name} ${input.command.text ?? ""}`.trim() : "";
    const hasAction = Boolean(input?.sessionAction?.name);
    if (!input?.runId || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.runId) || (typeof input.prompt !== "string" || !input.prompt.trim()) && !commandPrompt && !hasAction) throw httpError(400, "runId and non-empty prompt, native command, or session action are required");
    if (this.runs.has(input.runId)) {
      const existing = this.runs.get(input.runId);
      if (existing.prompt !== (input.prompt ?? commandPrompt) || JSON.stringify(existing.command??null)!==JSON.stringify(input.command??null) || JSON.stringify(existing.sessionAction??null)!==JSON.stringify(input.sessionAction??null) || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(input.attachments ?? [])) throw httpError(409, 'runId is already bound to another input');
      return this.public(existing);
    }
    if ([...this.runs.values()].some(run => !isTerminal(run.status))) throw httpError(409, 'computer already has an active run');
    const run = { id: input.runId, prompt: input.prompt ?? commandPrompt, command: input.command, sessionAction: input.sessionAction, attachments: Array.isArray(input.attachments) ? input.attachments : [], status: "provisioning", sessionId: input.sessionId, events: [], botDirectory: Array.isArray(input.botDirectory) ? input.botDirectory.map(bot=>({id:bot.id,name:bot.name})) : [], delegationHistory: input.delegationHistory ?? [], allowBotMessaging: input.allowBotMessaging !== false, delegationRequests: [], botCreationRequests: [], final: "", cancelRequested: false, startedAt: new Date().toISOString() };
    this.runs.set(run.id, run); this.persist(run);
    // Runs use the native runtime outside HTTP request handlers. Keep them in
    // the same idle barrier so checkpoint cannot stop the service mid-turn.
    this.runtimeOps += 1;
    void this.execute(run, input).finally(() => {
      this.runtimeOps -= 1;
      if (this.runtimeOps === 0) for (const resolve of this.runtimeIdle.splice(0)) resolve();
    });
    return this.public(run);
  }

  /** Admit a message into the native session inbox exactly once. The receipt
   * is written before calling OpenCode so a lost response is never retried
   * with a new native message id. */
  async steer(run, body) {
    if (!run) throw httpError(404, "run not found");
    const key = body?.idempotencyKey;
    const prompt = body?.prompt;
    const delivery = body?.delivery ?? "steer";
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw httpError(400, "idempotencyKey must contain 1 to 160 safe characters");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) throw httpError(400, "prompt must contain between 1 and 16000 characters");
    if (delivery !== "steer") throw httpError(400, "delivery must be steer");
    run.steeringMessages ??= [];
    const existing = run.steeringMessages.find(item => item.idempotencyKey === key);
    if (existing) {
      if (existing.prompt !== prompt || existing.delivery !== delivery || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(body.attachments ?? [])) throw httpError(409, "idempotencyKey is already bound to another steering message");
      if (existing.status !== "accepted") return { id: existing.id, status: "uncertain", sessionId: run.sessionId };
      return { id: existing.id, status: "accepted", sessionId: run.sessionId };
    }
    if (!run || isTerminal(run.status) || run.admissionClosing) throw httpError(409, "run is no longer active", { notAdmitted: true });
    if (!["running", "waiting_approval"].includes(run.status) || !run.sessionId) throw httpError(409, "run is not ready to receive steering messages");
    const messageId = `msg_${createHash("sha256").update(`${run.id}\0${key}`).digest("hex").slice(0, 40)}`;
    const files = attachmentFiles(body.attachments, this.runtime.directory);
    const receipt = { id: messageId, idempotencyKey: key, prompt, delivery, ...(Array.isArray(body.attachments) && body.attachments.length ? { attachments: body.attachments } : {}), status: "pending", createdAt: new Date().toISOString() };
    run.steeringMessages.push(receipt);
    this.persist(run);
    let releaseAdmission;
    const admission = new Promise(resolve => { releaseAdmission = resolve; });
    run.steeringAdmissions ??= new Set();
    run.steeringAdmissions.add(admission);
    try {
      const native = await this.runtime.prompt(run.sessionId, prompt, { messageId, delivery, files });
      receipt.status = "accepted";
      run.steeringGeneration = (run.steeringGeneration ?? 0) + 1;
      receipt.native = native?.data ?? native ?? null;
      receipt.acceptedAt = new Date().toISOString();
      this.persist(run);
      return { id: messageId, status: "accepted", sessionId: run.sessionId };
    } catch (error) {
      receipt.error = errorMessage(error);
      this.persist(run);
      receipt.status = "uncertain";
      this.persist(run);
      return { id: messageId, status: "uncertain", sessionId: run.sessionId };
    } finally {
      run.steeringAdmissions.delete(admission);
      releaseAdmission();
    }
  }

  botTool(name, args = {}) {
    const run = [...this.runs.values()].find(item => !isTerminal(item.status));
    if (!run || this.paused || this.configuring || run.cancelRequested) throw httpError(409, "Bot messaging requires an active application conversation");
    if (name === 'list_bots') return { bots: run.botDirectory ?? [] };
    if (name === 'get_replies') return { replies: run.delegationHistory ?? [], pending: run.delegationRequests ?? [] };
    if (name === 'create_bot') {
      if (!run.allowBotMessaging) throw httpError(409, 'This turn cannot create bots while receiving replies.');
      const nameValue = typeof args.name === 'string' ? args.name.trim() : '';
      if (!nameValue || nameValue.length > 160) throw httpError(400, 'Bot name must contain between 1 and 160 characters');
      const instructions = args.instructions === undefined ? '' : args.instructions;
      const model = args.model === undefined ? '' : args.model;
      const agent = args.agent === undefined ? '' : args.agent;
      if (typeof instructions !== 'string' || instructions.length > 20000) throw httpError(400, 'Bot instructions must contain 0 to 20000 characters');
      if (typeof model !== 'string' || model.length > 320) throw httpError(400, 'Bot model must contain 0 to 320 characters');
      if (typeof agent !== 'string' || agent.length > 160) throw httpError(400, 'Bot agent must contain 0 to 160 characters');
      run.botCreationRequests ??= [];
      const existing = run.botCreationRequests.find(item => item.name === nameValue && item.instructions === instructions && item.model === model && item.agent === agent);
      if (existing) return { ...existing, status: 'queued', instruction: 'End this turn to create the bot. Its settings and conversations will be available afterward.' };
      if (run.botCreationRequests.length >= 4) throw httpError(429, 'Maximum four bot creations per turn');
      const request = { id: randomUUID(), name: nameValue, instructions, model, agent };
      run.botCreationRequests.push(request);
      this.emit(run, 'bot.creation.queued', request);
      this.persist(run);
      return { ...request, status: 'queued', instruction: 'End this turn to create the bot. Its settings and conversations will be available afterward.' };
    }
    if (name !== 'send_message') throw httpError(404, 'Unknown bot tool');
    if (!run.allowBotMessaging) throw httpError(409, 'This turn is receiving replies. Summarize them for the user instead of sending more messages.');
    if (typeof args.targetBotId !== 'string' || !(run.botDirectory ?? []).some(bot=>bot.id===args.targetBotId)) throw httpError(400, 'Choose an exact target ID from list_bots');
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 16000) throw httpError(400, 'Message must contain between 1 and 16000 characters');
    run.delegationRequests ??= [];
    const existing = run.delegationRequests.find(item=>item.targetBotId===args.targetBotId && item.prompt===args.prompt.trim());
    if (existing) return { ...existing, status:'queued', instruction:'End this turn to let the recipient respond. Its reply automatically continues this conversation.' };
    if (run.delegationRequests.length >= 8) throw httpError(429, 'Maximum eight bot messages per turn');
    const request = { id:randomUUID(), targetBotId:args.targetBotId, prompt:args.prompt.trim() };
    run.delegationRequests.push(request);
    this.emit(run, 'bot.message.queued', request);
    this.persist(run);
    return { ...request, status:'queued', instruction:'End this turn to let the recipient respond. Its reply automatically continues this conversation.' };
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
      let steeringGenerationBeforeWait = run.steeringGeneration ?? 0;
      let messages = [];
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
        const files = attachmentFiles(input.attachments, input.directory ?? this.runtime.directory);
        await this.runtime.prompt(run.sessionId, !this.runtime.instructions && input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt, { files });
      }
      if (input.sessionAction) {
        // Native actions such as compact/revert may not create an assistant
        // message. Their explicit action result is the receipt.
        if (input.sessionAction.name === 'compact' && this.runtime.wait) await this.runtime.wait(run.sessionId, AbortSignal.timeout(30 * 60 * 1000));
      } else if (this.runtime.wait) {
        await this.waitForNativeCompletion(run);
        messages = (await this.runtime.messages(run.sessionId)).filter(message => !before.has(message.id) && message.type === 'assistant').sort((a,b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
        // OpenCode can append assistant messages for commentary and tool calls
        // after the user-facing answer. Use the last assistant message that
        // actually contains text, keeping its text parts together so a later
        // tool-only message cannot replace the final receipt.
        const finalMessage = [...messages].reverse().find(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0));
        if (finalMessage) run.final = finalMessage.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n\n');
        if (run.runtimeOutcome === 'session.execution.failed' || messages.some(message => message.error || message.finish === 'error')) throw new Error(messages.find(message => message.error)?.error?.message ?? messages.find(message => typeof message.error === 'string')?.error ?? 'OpenCode reported an execution error');
        if (!messages.length && !run.cancelRequested) throw new Error('Execution ended without an assistant result');
      } else await watcher;
      if (run.transportFailure) throw new Error(run.transportFailure);
      if (!isTerminal(run.status)) {
        // Close the admission gate before deciding the run is terminal. Any
        // native prompt already in flight is drained; later messages receive
        // a definitive notAdmitted conflict instead of being stranded.
        run.admissionClosing = true;
        this.persist(run);
        if (run.steeringAdmissions?.size) await Promise.all([...run.steeringAdmissions]);
        // A steer receipt means admission succeeded, but its execution may be
        // scheduled after the wait that completed the original turn. Drain
        // that follow-up before publishing terminal status.
        if ((run.steeringGeneration ?? 0) !== steeringGenerationBeforeWait) {
          await this.waitForNativeCompletion(run);
          messages = (await this.runtime.messages(run.sessionId)).filter(message => !before.has(message.id) && message.type === 'assistant').sort((a,b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
          const finalMessageAfterSteering = [...messages].reverse().find(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0));
          if (finalMessageAfterSteering) run.final = finalMessageAfterSteering.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n\n');
          if (run.transportFailure) throw new Error(run.transportFailure);
          if (run.runtimeOutcome === "session.execution.failed" || messages.some(message => message.error || message.finish === "error")) throw new Error("OpenCode reported an execution error after a follow-up message");
        }
        run.status = run.cancelRequested ? "cancelled" : "succeeded";
        this.emit(run, run.status, run.final ? { text: run.final } : {});
      }
    } catch (error) {
      const transportError = isTransientTransportError(error);
      if (transportError && !run.transportFailure) run.transportFailure = `The native runtime lost its connection while starting this task${errorMessage(error) ? ` (${errorMessage(error)})` : ''}.`;
      const nextStatus = run.cancelRequested ? "cancelled" : (run.transportFailure || transportError || error.name === 'TimeoutError' || error.name === 'AbortError') ? 'needs_review' : "failed";
      if (nextStatus === 'needs_review' && run.sessionId) {
        try {
          await this.runtime.interrupt(run.sessionId);
        } catch (interruptError) {
          try {
            if (this.runtime.stop) await this.runtime.stop();
            else throw interruptError;
          } catch (stopError) {
            this.ownershipUncertain = true;
            run.ownershipUncertain = true;
            run.transportFailure = `${run.transportFailure ?? 'The native runtime lost its connection.'} Native ownership could not be confirmed stopped; restart the computer before retrying.`;
          }
        }
      }
      run.admissionClosing = true;
      this.persist(run);
      if (run.steeringAdmissions?.size) await Promise.all([...run.steeringAdmissions]);
      run.status = nextStatus;
      this.emit(run, "error", { message: run.transportFailure ?? errorMessage(error) });
    } finally {
      controller.abort();
      run.finishedAt = new Date().toISOString();
      this.persist(run);
    }
  }

  async waitForNativeCompletion(run) {
    let lastTransportError;
    // `session.wait` is a bounded HTTP request in the native service.  An
    // approval can legitimately leave the model idle for longer than that
    // request, so do not turn a request timeout into a cancelled/review run
    // while the run is waiting for a human decision.  Keep each individual
    // request bounded, and retain the finite retry budget for ordinary turns.
    const requestTimeoutMs = this.nativeWaitTimeoutMs;
    let attempt = 0;
    let approvalReconnects = 0;
    let approvalCheckFailures = 0;
    for (;;) {
      try {
        await this.runtime.wait(run.sessionId, AbortSignal.timeout(requestTimeoutMs));
        return undefined;
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        if (!isTransientTransportError(error) && !timeout) throw error;
        lastTransportError = error;
        attempt += 1;
        this.emit(run, 'connection.recovering', { attempt, message: errorMessage(error) });
        const approvalPending = await this.confirmPendingApproval(run);
        if (approvalPending) {
          // The native model is still alive and blocked on permission. Reopen
          // the bounded wait until the approval endpoint changes run.status.
          approvalReconnects += 1;
          approvalCheckFailures = 0;
          const delay = Math.min(5_000, 100 * 2 ** Math.min(approvalReconnects - 1, 5));
          attempt = 0;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        approvalCheckFailures += 1;
        approvalReconnects = 0;
        if (attempt >= 3 || approvalCheckFailures >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
    run.transportFailure = `The native runtime lost its connection while waiting for this task to finish${lastTransportError?.message ? ` (${lastTransportError.message})` : ''}.`;
    throw lastTransportError ?? new Error(run.transportFailure);
  }

  async confirmPendingApproval(run) {
    if (run.status !== 'waiting_approval') return false;
    // Test doubles and older runtimes without a permission listing endpoint
    // can only be confirmed by the event stream's state.
    if (!this.runtime.permissions) return true;
    try {
      const permissions = await this.runtime.permissions(run.sessionId, AbortSignal.timeout(Math.min(this.nativeWaitTimeoutMs, 30_000)));
      if (!Array.isArray(permissions) || permissions.length === 0) return false;
      for (const permission of permissions) {
        if (run.events.some(event => event.type === 'approval.requested' && event.data.requestId === permission.id)) continue;
        this.emit(run, 'approval.requested', { ...permission, requestId: permission.id });
      }
      return true;
    } catch {
      return false;
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
        if (type === 'session.retry.scheduled' && /UNKNOWN_CERTIFICATE_VERIFICATION_ERROR|CERTIFICATE_VERIFY_FAILED/.test(eventData.error?.message ?? '')) {
          run.transportFailure = 'The computer could not establish a secure connection to the model provider. Provider retries were stopped. Check the computer’s network connection before retrying. (' + eventData.error.message + ')';
          this.emit(run, 'connection.failed', { message: run.transportFailure });
          await this.runtime.interrupt(run.sessionId);
          if (!this.runtime.wait) run.status = 'needs_review';
          break;
        }
        if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(type)) {
          run.runtimeOutcome = type;
          if (!this.runtime.wait) {
            run.status = type.endsWith('succeeded') ? 'succeeded' : type.endsWith('failed') ? 'failed' : 'cancelled';
            break;
          }
        }
      }
    } catch (error) {
      if (!isTerminal(run.status)) this.emit(run, "stream.error", { message: errorMessage(error) });
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
    if (run.status !== 'waiting_approval') throw httpError(409, "run is not waiting for approval");
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
    await this.recoverNativeOwnership();
    if (this.configuring || this.paused || this.ownershipUncertain) throw httpError(409, "computer settings or checkpoint are being updated");
    this.paused = true;
    // Preserve the fast conflict response for ordinary active work. A run
    // already in review may still be unwinding after an ownership loss, so it
    // is drained by the runtime idle barrier below before the archive starts.
    const activeBeforeWait = [...this.runs.values()].filter((run) => !isTerminal(run.status) && run.status !== "needs_review");
    if (activeBeforeWait.length) { this.paused = false; throw httpError(409, "cannot checkpoint while runs are active"); }
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
  public(run) { return { delegationRequests: run.delegationRequests ?? [], botCreationRequests: run.botCreationRequests ?? [], steeringMessages: (run.steeringMessages ?? []).map(({ id, idempotencyKey, prompt, delivery, status, createdAt, acceptedAt }) => ({ id, idempotencyKey, prompt, delivery, status, createdAt, acceptedAt })), runId: run.id, status: run.status, sessionId: run.sessionId, events: run.events, final: run.final, error: ['failed','needs_review'].includes(run.status) ? run.events.findLast(event => event.type === 'error')?.data?.message : undefined, startedAt: run.startedAt, finishedAt: run.finishedAt }; }
  load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    for (const file of fs.readdirSync(this.stateDir).filter((name) => name.endsWith(".json"))) {
      try {
        if (file === "checkpoint.json") continue;
        const run = JSON.parse(fs.readFileSync(path.join(this.stateDir, file), "utf8"));
        if (!run.id) continue;
        if (run.status && !isTerminal(run.status)) { run.status = "needs_review"; run.events ??= []; run.events.push({ seq: run.events.length + 1, type: "recovery.needs_review", data: { reason: "runner restarted before terminal receipt" } }); }
        if (run.sessionId && !run.ownershipStopped && (run.ownershipUncertain || (run.status === "needs_review" && run.events?.some(event => event.type === "recovery.needs_review")))) this.recoverySessions.add(run.sessionId);
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

export function createServer({ store, authToken = token, botToolToken, workspace = process.env.WORKSPACE_DIRECTORY ?? '/workspace/shared', desktop, terminalRoutes } = {}) {
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
  const plugins = createPluginRoutes({workspace,runtimeRoot:store.runtime.root,updateConfiguration:fn=>store.updateConfiguration(fn),reloadRuntime:async()=>{store.runtime.catalogCache?.clear();}});
  const extensions = createExtensionRoutes({ workspace, updateConfiguration: (fn) => store.updateConfiguration(fn) });
  return http.createServer(async (req, res) => {
    try {
      if (req.url === "/health" && req.method === "GET") return json(res, 200, { ok: true, service: "opencode2-runner", instanceId: store.instanceId });
      if (req.url === '/bot-tools' && req.method === 'POST') {
        if (!botToolToken || req.headers.authorization !== `Bearer ${botToolToken}`) return json(res,401,{error:'unauthorized'});
        const input = await readJson(req);
        return json(res,200,store.botTool(input.name,input.arguments));
      }
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
      if (await extensions.handle(req, res)) return;
      if (await plugins.handle(req, res)) return;
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
      const providerPath = new URL(req.url,'http://runner').pathname;
      if (providerPath === '/providers' || providerPath.startsWith('/providers/')) {
        if (req.method === 'GET' && providerPath === '/providers') return json(res,200,await store.withRuntime(() => store.runtime.providers(workspace)));
        const methods = {
          '/providers/key':'configureProvider',
          '/providers/custom':'configureCustomProvider',
          '/providers/credentials/activate':'activateProviderCredential',
          '/providers/credentials/label':'updateProviderCredential',
          '/providers/credentials/remove':'removeProviderCredential',
          '/providers/oauth/start':'providerOAuthStart',
          '/providers/oauth/status':'providerOAuthStatus',
          '/providers/oauth/complete':'providerOAuthComplete',
          '/providers/oauth/cancel':'providerOAuthCancel',
          '/providers/command/start':'providerCommandStart',
          '/providers/command/status':'providerCommandStatus',
          '/providers/command/cancel':'providerCommandCancel',
        };
        const method=methods[providerPath];
        if (req.method !== 'POST' || !method) return json(res,404,{error:'Provider operation not found'});
        if (!store.runtime[method]) return json(res,501,{error:'This OpenCode runtime does not expose that provider operation'});
        if (!providerPath.endsWith('/status') && (store.terminalRegistry?.active() || [...store.runs.values()].some(run=>!isTerminal(run.status)))) return json(res,409,{error:'Finish the active request or close Native OpenCode before changing provider settings.'});
        const input=await readJson(req);
        try {
          const invoke=() => store.runtime[method]({...input,directory:workspace});
          const result=await (providerPath.endsWith("/status") ? store.withRuntime(invoke) : store.updateConfiguration(invoke));
          return json(res,200,result);
        } catch (error) {
          if (error.statusCode === 409) return json(res,409,{error:"Finish active work before changing computer settings"});
          // Native provider failures may include request bodies. Never return
          // credential-bearing SDK errors or write these requests to run logs.
          return json(res,400,{error:'OpenCode could not complete the provider operation. Check the required fields and credentials, then try again.'});
        }
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
        const messages = await store.withRuntime(() => store.runtime.messages(sessionMessages[1], {cache:true}));
        return json(res, 200, { sessionId: sessionMessages[1], messages: Array.isArray(messages) ? messages.slice().sort((a,b) => (b.time?.created ?? 0) - (a.time?.created ?? 0)).slice(0,200) : [] });
      }
      const sessionRemove = new URL(req.url, 'http://runner').pathname.match(/^\/sessions\/([A-Za-z0-9._:-]{1,160})$/);
      if (sessionRemove && req.method === "DELETE") {
        if (!store.runtime.removeSession) return json(res, 501, { error: "session removal is unavailable" });
        await store.updateConfiguration(async () => {
          await store.runtime.removeSession(sessionRemove[1]);
          store.forgetSessionRuns(sessionRemove[1]);
        });
        return json(res, 200, { deleted: true, sessionId: sessionRemove[1] });
      }
      const match = new URL(req.url, "http://runner").pathname.match(/^\/runs(?:\/([^/]+)(?:\/(cancel|approval))?)?$/);
      const messageMatch = new URL(req.url, "http://runner").pathname.match(/^\/runs\/([A-Za-z0-9._:-]{1,160})\/messages$/);
      if (messageMatch && req.method === "POST") {
        const body = await readJson(req);
        return json(res, 200, await store.withRuntime(() => store.steer(store.get(messageMatch[1]), body)));
      }
      if (!match) return json(res, 404, { error: "not found" });
      const body = await readJson(req);
      if (req.method === "POST" && !match[1]) return json(res, 202, await store.start(body));
      if (req.method === "GET" && match[1]) {
        const run = store.get(match[1]);
        if (run && !store.paused) await store.withRuntime(() => store.refresh(run));
        return run ? json(res, 200, store.public(run)) : json(res, 404, { error: "run not found" });
      }
      if (req.method === "POST" && match[2] === "cancel") return json(res, 200, await store.withRuntime(() => store.cancel(store.get(match[1]))));
      if (req.method === "POST" && match[2] === "approval") return json(res, 200, await store.approval(store.get(match[1]), body));
      return json(res, 405, { error: "method not allowed" });
    } catch (error) { const status = error?.statusCode ?? 500; json(res, status, { error: errorMessage(error), ...(error?.notAdmitted === true ? { notAdmitted: true } : {}) }); }
  });
}

function isTerminal(status) { return ["succeeded", "failed", "cancelled", "needs_review"].includes(status); }
function httpError(statusCode, message, details = {}) { return Object.assign(new Error(message), { statusCode, ...details }); }
function attachmentFiles(attachments, directory) {
  if (attachments === undefined) return undefined;
  if (!Array.isArray(attachments) || attachments.length > 8) throw httpError(400, "attachments are invalid");
  const root = path.resolve(String(directory ?? "/workspace/shared"));
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment.path !== "string" || !attachment.path || path.isAbsolute(attachment.path) || attachment.path.split(/[\\/]+/).some((part) => part === ".." || part === "." || part.startsWith("."))) throw httpError(400, "attachment path is invalid");
    const resolved = path.resolve(root, attachment.path);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw httpError(400, "attachment path is invalid");
    return { uri: `file://${resolved}`, name: String(attachment.name ?? "attachment").slice(0, 120), description: String(attachment.mimeType ?? "application/octet-stream").slice(0, 160) };
  });
}
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
  const botToolToken = randomUUID();
  const runtime = new OpenCode2Runtime({ botTools: { command: [process.execPath, fileURLToPath(new URL("./bot-mcp.mjs", import.meta.url))], env: { BOT_TOOLS_URL: `http://127.0.0.1:${port}/bot-tools`, BOT_TOOLS_TOKEN: botToolToken } }, root, directory: process.env.WORKSPACE_DIRECTORY ?? "/workspace/shared", desktop });
  createServer({ store: new RunStore(runtime, { stateDir: path.join(root, "runs") }), desktop, botToolToken }).listen(port, process.env.RUNNER_HOST ?? "127.0.0.1", () => console.log(`runner listening on ${port}`));
}
