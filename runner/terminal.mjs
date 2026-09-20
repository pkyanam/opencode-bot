import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_SCROLLBACK = 1_000_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_COLS = 500;
const MAX_ROWS = 200;

/** Native OpenCode 2.0.11 TUI attached to an existing session. */
export class NativeSessionTerminal extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.serverUrl || typeof options.serverUrl !== "string") throw new Error("serverUrl is required");
    if (!options.sessionId || typeof options.sessionId !== "string") throw new Error("sessionId is required");
    this.command = options.command ?? defaultCliCommand();
    this.serverUrl = options.serverUrl;
    this.sessionId = options.sessionId;
    this.authEnv = { ...(options.authEnv ?? {}) };
    this.cwd = options.cwd;
    this.cols = boundedDimension(options.cols, DEFAULT_COLS, MAX_COLS);
    this.rows = boundedDimension(options.rows, DEFAULT_ROWS, MAX_ROWS);
    this.maxScrollback = boundedDimension(options.maxScrollback, DEFAULT_MAX_SCROLLBACK, 10_000_000);
    this.ptyFactory = options.ptyFactory;
    this.pty = undefined;
    this.started = false;
    this.closed = false;
    this.output = "";
    this.outputOffset = 0;
    this.outputEnd = 0;
  }

  async start() {
    if (this.started) return this;
    if (this.closed) throw new Error("terminal is closed");
    const ptyFactory = this.ptyFactory ?? await loadPty();
    const env = { ...process.env, ...this.authEnv, OPENCODE_SERVER_URL: this.serverUrl };
    const args = terminalArgs(this.serverUrl, this.sessionId);
    this.pty = ptyFactory.spawn(this.command, args, {
      name: "xterm-256color", cols: this.cols, rows: this.rows,
      ...(this.cwd ? { cwd: this.cwd } : {}), env,
    });
    this.pty.onData((data) => this.appendOutput(String(data)));
    this.pty.onExit((event) => { this.started = false; this.emit("exit", event); });
    this.started = true;
    this.emit("start", { sessionId: this.sessionId, serverUrl: this.serverUrl });
    return this;
  }

  write(input) {
    if (!this.pty || !this.started) throw new Error("terminal is not started");
    if (typeof input !== "string" || input.length > 256_000) throw new Error("terminal input is invalid or too large");
    this.pty.write(input);
  }

  resize(cols, rows) {
    const nextCols = boundedDimension(cols, this.cols, MAX_COLS);
    const nextRows = boundedDimension(rows, this.rows, MAX_ROWS);
    this.cols = nextCols; this.rows = nextRows;
    if (this.pty && this.started) this.pty.resize(nextCols, nextRows);
    return { cols: nextCols, rows: nextRows };
  }

  read(after = this.outputOffset) {
    const requested = Number.isFinite(Number(after)) ? Math.max(0, Number(after)) : this.outputOffset;
    const truncated = requested < this.outputOffset;
    const start = truncated ? this.outputOffset : requested;
    const skip = Math.max(0, start - this.outputOffset);
    return {
      data: Buffer.from(this.output, "utf8").subarray(skip).toString("utf8"),
      offset: this.outputEnd, startOffset: this.outputOffset, truncated,
      closed: this.closed || !this.started,
    };
  }

  appendOutput(data) {
    if (!data) return;
    this.output += data;
    const originalBytes = Buffer.byteLength(data, "utf8");
    let bytes = Buffer.byteLength(this.output, "utf8");
    if (bytes > this.maxScrollback) {
      const encoded = Buffer.from(this.output, "utf8");
      this.output = encoded.subarray(encoded.length - this.maxScrollback).toString("utf8");
      bytes = Buffer.byteLength(this.output, "utf8");
      this.outputOffset = this.outputEnd + originalBytes - bytes;
    }
    this.outputEnd += originalBytes;
    if (this.outputOffset > this.outputEnd) this.outputOffset = this.outputEnd - bytes;
    this.emit("data", data);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pty) { try { this.pty.kill(); } catch { /* process may already have exited */ } this.pty = undefined; }
    this.started = false;
    this.emit("close");
  }

  status() { return { started: this.started, closed: this.closed, sessionId: this.sessionId, serverUrl: this.serverUrl, cols: this.cols, rows: this.rows, offset: this.outputEnd }; }
}

/** Serializes attach/close and admits at most one human controller. */
export class TerminalRegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.create = options.create ?? ((connection) => new NativeSessionTerminal(connection));
    this.maxScrollback = options.maxScrollback ?? DEFAULT_MAX_SCROLLBACK;
    this.terminals = new Map(); this.sessionTerminal = new Map(); this.admission = Promise.resolve();
    this.leases = new Map(); this.leaseMs = options.leaseMs ?? 60_000; this.connecting = 0;
  }
  async attach(connection) {
    this.connecting++;
    try { return await this.#serialized(async () => {
      if (!connection?.sessionId || !connection.serverUrl) throw httpError(400, "sessionId and runtime connection are required");
      const existingId = this.sessionTerminal.get(connection.sessionId);
      if (existingId && this.terminals.has(existingId)) return this.describe(this.terminals.get(existingId), existingId, true);
      if (this.terminals.size) throw httpError(409, "a terminal controller is already attached");
      const terminal = this.create({ ...connection, maxScrollback: this.maxScrollback });
      const id = randomUUID(); await terminal.start();
      this.terminals.set(id, terminal); this.sessionTerminal.set(connection.sessionId, id);
      this.touch(id);
      terminal.once("exit", () => this.cleanup(id)); terminal.once("close", () => this.cleanup(id));
      this.emit("attach", { id, sessionId: connection.sessionId });
      return this.describe(terminal, id, false);
    }); } finally { this.connecting--; }
  }
  touch(id) { clearTimeout(this.leases.get(id)); const timer=setTimeout(()=>{void this.close(id).catch(()=>{});},this.leaseMs); timer.unref?.(); this.leases.set(id,timer); }
  get(id) { const terminal=this.terminals.get(id); if(terminal)this.touch(id); return terminal; }
  active() { return this.connecting > 0 || this.terminals.size > 0; }
  activeSession(sessionId) { return this.sessionTerminal.has(sessionId); }
  async close(id) { return this.#serialized(async () => { const t = this.terminals.get(id); if (!t) throw httpError(404, "terminal not found"); await t.close(); this.cleanup(id); return { terminalId: id, closed: true }; }); }
  describe(terminal, id, existing = false) { return { terminalId: id, sessionId: terminal.sessionId, cols: terminal.cols, rows: terminal.rows, offset: terminal.outputEnd, existing }; }
  cleanup(id) { clearTimeout(this.leases.get(id));this.leases.delete(id); const t = this.terminals.get(id); if (!t) return; this.terminals.delete(id); if (this.sessionTerminal.get(t.sessionId) === id) this.sessionTerminal.delete(t.sessionId); this.emit("cleanup", { id, sessionId: t.sessionId }); }
  async #serialized(task) { const prior = this.admission; let release; this.admission = new Promise((resolve) => { release = resolve; }); await prior; try { return await task(); } finally { release(); } }
}

export function terminalArgs(serverUrl, sessionId) { return ["--server", serverUrl, "--session", sessionId]; }
export function defaultCliCommand() { return process.env.OPENCODE2_BIN ?? fileURLToPath(new URL("./node_modules/.bin/opencode2", import.meta.url)); }
function boundedDimension(value, fallback, maximum) { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, maximum) : fallback; }
async function loadPty() { try { const module = await import("@lydell/node-pty"); return module.default ?? module; } catch (error) { throw new Error(`Interactive terminal requires @lydell/node-pty: ${error.message}`); } }
export function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
