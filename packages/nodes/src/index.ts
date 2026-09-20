/**
 * Durable registry for user-owned execution nodes.
 *
 * This module contains the persistence and HTTP protocol, but deliberately
 * does not own a Durable Object or expose a listener. Workspace can delegate
 * /api/nodes/* requests to `NodeRegistry.handle`; the Worker remains the only
 * public endpoint.
 */

export type SqlStorage = {
  exec(query: string, ...args: unknown[]): {
    toArray(): unknown[];
    rowsWritten?: number;
  };
};

export type NodePlatform = "macos" | "linux" | "windows";

export type NodeCapabilities = {
  os: NodePlatform;
  arch: string;
  runner: boolean;
  desktop: boolean;
  browser: boolean;
  maxParallelJobs: number;
  [key: string]: unknown;
};

export type NodeRecord = {
  id: string;
  name: string;
  platform: NodePlatform;
  arch: string;
  capabilities: NodeCapabilities;
  agentVersion?: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  online: boolean;
};

export type Pairing = {
  token: string;
  expiresAt: string;
  label?: string;
};

export type RunnerJobPayload = {
  kind: "runner.run";
  runnerUrl?: string;
  run: Record<string, unknown>;
};

export type NodeJob = {
  id: string;
  nodeId: string;
  status: "queued" | "leased" | "succeeded" | "failed" | "needs_review";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  result?: unknown;
  error?: string;
};

export type NodeRegistryOptions = {
  /** How long since the last heartbeat a node is still considered online. */
  heartbeatTimeoutMs?: number;
  /** Clock seam for tests and deterministic Durable Object behavior. */
  now?: () => Date;
  randomId?: (prefix: string) => string;
};

export type NodeRequestContext = {
  /** Workspace passes its already-verified owner credential for admin routes. */
  adminAuthorized?: boolean;
};

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const JOB_LEASE_MS = 45_000;
const MAX_BODY_BYTES = 256_000;

export class NodeHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "NodeHttpError";
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() || null : null;
}

function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let value = "";
  for (const byte of data) value += byte.toString(16).padStart(2, "0");
  return value;
}

function parsePlatform(value: unknown): NodePlatform {
  if (value === "macos" || value === "linux" || value === "windows") return value;
  throw new NodeHttpError(400, "platform must be macos, linux, or windows");
}

function nonEmpty(value: unknown, field: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new NodeHttpError(400, `${field} must be a non-empty string`);
  return value.trim();
}

function mapNode(row: Record<string, unknown>, now: Date, timeout: number): NodeRecord {
  const lastSeenAt = typeof row.last_seen_at === "string" ? row.last_seen_at : undefined;
  const lastSeen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  return {
    id: String(row.id),
    name: String(row.name),
    platform: row.platform as NodePlatform,
    arch: String(row.arch),
    capabilities: parseJson(row.capabilities, {} as NodeCapabilities),
    ...(row.agent_version ? { agentVersion: String(row.agent_version) } : {}),
    createdAt: String(row.created_at),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    online: !row.revoked_at && Number.isFinite(lastSeen) && now.getTime() - lastSeen <= timeout,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(value));
    return parsed as T;
  } catch {
    return fallback;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
    throw new NodeHttpError(413, "request body too large");
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new NodeHttpError(400, "invalid JSON body");
  }
}

export class NodeRegistry {
  private readonly timeout: number;
  private readonly clock: () => Date;
  private readonly idFactory: (prefix: string) => string;

  constructor(private readonly sql: SqlStorage, options: NodeRegistryOptions = {}) {
    this.timeout = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.clock = options.now ?? (() => new Date());
    this.idFactory = options.randomId ?? ((prefix) => `${prefix}_${randomToken(16)}`);
    this.init();
  }

  /** Safe to call from every DO instance construction; all statements are idempotent. */
  init(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS node_pairings (
      token_hash TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      agent_version TEXT,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS node_jobs (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      lease_expires_at TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    try { this.sql.exec("ALTER TABLE node_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"); } catch { /* existing schema */ }
    this.sql.exec("CREATE INDEX IF NOT EXISTS nodes_seen ON nodes(last_seen_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS node_jobs_queue ON node_jobs(node_id, status, created_at)");
  }

  private now(): Date { return this.clock(); }
  private rows<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec(query, ...args).toArray() as T[];
  }
  private one<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): T | undefined {
    return this.rows<T>(query, ...args)[0];
  }

  async createPairing(input: { label?: unknown; ttlMs?: unknown } = {}): Promise<Pairing> {
    const ttl = input.ttlMs === undefined ? DEFAULT_PAIRING_TTL_MS : Number(input.ttlMs);
    if (!Number.isInteger(ttl) || ttl < 10_000 || ttl > 24 * 60 * 60_000)
      throw new NodeHttpError(400, "ttlMs must be between 10000 and 86400000");
    const now = this.now();
    const token = `np_${randomToken(32)}`;
    const label = input.label === undefined ? undefined : nonEmpty(input.label, "label");
    this.sql.exec(
      "INSERT INTO node_pairings (token_hash,label,created_at,expires_at) VALUES (?,?,?,?)",
      await sha256(token), label ?? null, now.toISOString(), new Date(now.getTime() + ttl).toISOString(),
    );
    return { token, expiresAt: new Date(now.getTime() + ttl).toISOString(), ...(label ? { label } : {}) };
  }

  async register(input: Record<string, unknown>): Promise<{ node: NodeRecord; nodeSecret: string }> {
    const pairingToken = nonEmpty(input.pairingToken, "pairingToken", 256);
    const tokenHash = await sha256(pairingToken);
    const now = this.now();
    const name = nonEmpty(input.name, "name");
    const platform = parsePlatform(input.platform);
    const arch = nonEmpty(input.arch ?? "unknown", "arch", 80);
    const capabilityInput = input.capabilities;
    if (!capabilityInput || typeof capabilityInput !== "object" || Array.isArray(capabilityInput))
      throw new NodeHttpError(400, "capabilities must be an object");
    // The conditional update makes redemption single-use even if two agents
    // race to redeem the same pairing token.
    const claimed = this.sql.exec(
      "UPDATE node_pairings SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
      now.toISOString(), tokenHash, now.toISOString(),
    );
    if (!claimed.rowsWritten) throw new NodeHttpError(401, "pairing token is invalid, expired, or already used");
    const capabilities = {
      ...(capabilityInput as Record<string, unknown>),
      os: platform,
      arch,
      runner: (capabilityInput as Record<string, unknown>).runner === true,
      desktop: (capabilityInput as Record<string, unknown>).desktop === true,
      browser: (capabilityInput as Record<string, unknown>).browser === true,
      maxParallelJobs: Math.max(1, Math.min(8, Number((capabilityInput as Record<string, unknown>).maxParallelJobs ?? 1) || 1)),
    } satisfies NodeCapabilities;
    const id = this.idFactory("node");
    const secret = `ns_${randomToken(32)}`;
    this.sql.exec(
      "INSERT INTO nodes (id,name,platform,arch,capabilities,agent_version,secret_hash,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, name, platform, arch, JSON.stringify(capabilities), typeof input.agentVersion === "string" ? input.agentVersion.slice(0, 80) : null,
      await sha256(secret), now.toISOString(), now.toISOString(),
    );
    const row = this.one("SELECT * FROM nodes WHERE id=?", id)!;
    return { node: mapNode(row, now, this.timeout), nodeSecret: secret };
  }

  list(): NodeRecord[] {
    const now = this.now();
    return this.rows("SELECT * FROM nodes ORDER BY created_at").map((row) => mapNode(row, now, this.timeout));
  }

  get(nodeId: string): NodeRecord | null {
    const row = this.one("SELECT * FROM nodes WHERE id=?", nodeId);
    return row ? mapNode(row, this.now(), this.timeout) : null;
  }

  revoke(id: string): NodeRecord {
    const now = this.now();
    const result = this.sql.exec("UPDATE nodes SET revoked_at=? WHERE id=? AND revoked_at IS NULL", now.toISOString(), id);
    if (!result.rowsWritten) {
      const row = this.one("SELECT * FROM nodes WHERE id=?", id);
      if (!row) throw new NodeHttpError(404, "node not found");
    }
    this.sql.exec("UPDATE node_jobs SET status='needs_review', error='node revoked; refusing delivery', lease_expires_at=NULL, updated_at=? WHERE node_id=? AND status IN ('queued','leased')", now.toISOString(), id);
    return mapNode(this.one("SELECT * FROM nodes WHERE id=?", id)!, now, this.timeout);
  }

  async authenticate(id: string, secret: string | null): Promise<NodeRecord | null> {
    if (!secret) return null;
    const row = this.one("SELECT * FROM nodes WHERE id=? AND revoked_at IS NULL AND secret_hash=?", id, await sha256(secret));
    return row ? mapNode(row, this.now(), this.timeout) : null;
  }

  async heartbeat(id: string, secret: string | null, input: Record<string, unknown> = {}): Promise<NodeRecord> {
    const node = await this.authenticate(id, secret);
    if (!node) throw new NodeHttpError(401, "invalid node credential");
    const now = this.now();
    this.sql.exec("UPDATE nodes SET last_seen_at=?, capabilities=COALESCE(?,capabilities), agent_version=COALESCE(?,agent_version) WHERE id=? AND revoked_at IS NULL", now.toISOString(),
      input.capabilities && typeof input.capabilities === "object" ? JSON.stringify({ ...node.capabilities, ...(input.capabilities as object) }) : null,
      typeof input.agentVersion === "string" ? input.agentVersion.slice(0, 80) : null, id);
    // A long running local runner job remains owned by the live agent while
    // its heartbeat keeps arriving. This prevents a second poll from
    // reclaiming it after the short lease expires.
    this.sql.exec("UPDATE node_jobs SET lease_expires_at=?, updated_at=? WHERE node_id=? AND status='leased'", new Date(now.getTime() + JOB_LEASE_MS).toISOString(), now.toISOString(), id);
    return mapNode(this.one("SELECT * FROM nodes WHERE id=?", id)!, now, this.timeout);
  }

  async enqueue(nodeId: string, payload: Record<string, unknown>, priority = 0): Promise<NodeJob> {
    if (!this.one("SELECT id FROM nodes WHERE id=? AND revoked_at IS NULL", nodeId)) throw new NodeHttpError(404, "node not found");
    if (!payload || typeof payload !== "object" || typeof payload.kind !== "string") throw new NodeHttpError(400, "job payload kind is required");
    const now = this.now();
    const id = this.idFactory("job");
    if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new NodeHttpError(400, "job priority must be between 0 and 100");
    this.sql.exec("INSERT INTO node_jobs (id,node_id,status,priority,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", id, nodeId, "queued", priority, JSON.stringify(payload), now.toISOString(), now.toISOString());
    return this.job(this.one("SELECT * FROM node_jobs WHERE id=?", id)!);
  }

  async poll(nodeId: string, secret: string | null): Promise<NodeJob | null> {
    const node = await this.authenticate(nodeId, secret);
    if (!node) throw new NodeHttpError(401, "invalid node credential");
    const now = this.now();
    // An expired lease is ambiguous: the runner may have completed an
    // external side effect before the agent disappeared. Never replay it
    // automatically. Workspace can explicitly review/reconcile by job id.
    this.sql.exec("UPDATE node_jobs SET status='needs_review', error='agent lease expired; refusing automatic replay', lease_expires_at=NULL, updated_at=? WHERE node_id=? AND status='leased' AND lease_expires_at<=?", now.toISOString(), nodeId, now.toISOString());
    const row = this.one("SELECT * FROM node_jobs WHERE node_id=? AND status='queued' ORDER BY priority DESC, created_at LIMIT 1", nodeId);
    if (!row) return null;
    this.sql.exec("UPDATE node_jobs SET status='leased', lease_expires_at=?, updated_at=? WHERE id=? AND status='queued'", new Date(now.getTime() + JOB_LEASE_MS).toISOString(), now.toISOString(), row.id);
    return this.job(this.one("SELECT * FROM node_jobs WHERE id=?", row.id)!);
  }

  getJob(jobId: string): NodeJob | null {
    const row = this.one("SELECT * FROM node_jobs WHERE id=?", jobId);
    if (!row) return null;
    const now = this.now();
    if (row.status === "leased" && typeof row.lease_expires_at === "string" && row.lease_expires_at <= now.toISOString()) {
      this.sql.exec("UPDATE node_jobs SET status='needs_review', error='agent lease expired; refusing automatic replay', lease_expires_at=NULL, updated_at=? WHERE id=? AND status='leased'", now.toISOString(), jobId);
      return this.job(this.one("SELECT * FROM node_jobs WHERE id=?", jobId)!);
    }
    return this.job(row);
  }

  async submitResult(nodeId: string, secret: string | null, jobId: string, input: Record<string, unknown>): Promise<NodeJob> {
    const node = await this.authenticate(nodeId, secret);
    if (!node) throw new NodeHttpError(401, "invalid node credential");
    const row = this.one("SELECT * FROM node_jobs WHERE id=? AND node_id=?", jobId, nodeId);
    if (!row) throw new NodeHttpError(404, "job not found");
    if (row.status !== "leased") throw new NodeHttpError(409, "job is no longer leased");
    const now = this.now();
    const succeeded = input.ok === true;
    this.sql.exec("UPDATE node_jobs SET status=?, result=?, error=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND status='leased'", succeeded ? "succeeded" : "failed", input.result === undefined ? null : JSON.stringify(input.result), typeof input.error === "string" ? input.error.slice(0, 2000) : null, now.toISOString(), jobId);
    return this.job(this.one("SELECT * FROM node_jobs WHERE id=?", jobId)!);
  }

  async submitProgress(nodeId: string, secret: string | null, jobId: string, input: Record<string, unknown>): Promise<NodeJob> {
    const node = await this.authenticate(nodeId, secret);
    if (!node) throw new NodeHttpError(401, "invalid node credential");
    const row = this.one("SELECT * FROM node_jobs WHERE id=? AND node_id=?", jobId, nodeId);
    if (!row) throw new NodeHttpError(404, "job not found");
    if (row.status !== "leased") throw new NodeHttpError(409, "job is no longer leased");
    if (!input.result || typeof input.result !== "object") throw new NodeHttpError(400, "progress result is required");
    const now = this.now();
    this.sql.exec("UPDATE node_jobs SET result=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='leased'", JSON.stringify(input.result), new Date(now.getTime() + JOB_LEASE_MS).toISOString(), now.toISOString(), jobId);
    return this.job(this.one("SELECT * FROM node_jobs WHERE id=?", jobId)!);
  }

  private job(row: Record<string, unknown>): NodeJob {
    return {
      id: String(row.id), nodeId: String(row.node_id), status: row.status as NodeJob["status"], payload: parseJson(row.payload, {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}), ...(row.result ? { result: parseJson(row.result, null) } : {}), ...(row.error ? { error: String(row.error) } : {}),
    };
  }

  /** Route handler. Parent code remains responsible for owner authentication. */
  async handle(request: Request, context: NodeRequestContext = {}): Promise<Response> {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      const base = segments[0] === "api" && segments[1] === "nodes" ? 2 : segments[0] === "nodes" ? 1 : -1;
      if (base < 0) throw new NodeHttpError(404, "not found");
      const tail = segments.slice(base);
      if (request.method === "POST" && tail.length === 1 && tail[0] === "pairing") {
        if (!context.adminAuthorized) throw new NodeHttpError(401, "owner authorization required");
        return jsonResponse(await this.createPairing(await requestJson(request)), 201);
      }
      if (request.method === "POST" && tail.length === 1 && tail[0] === "register")
        return jsonResponse(await this.register(await requestJson(request)), 201);
      if (request.method === "GET" && tail.length === 0) {
        if (!context.adminAuthorized) throw new NodeHttpError(401, "owner authorization required");
        return jsonResponse({ nodes: this.list() });
      }
      if (request.method === "POST" && tail.length === 2 && tail[1] === "revoke") {
        if (!context.adminAuthorized) throw new NodeHttpError(401, "owner authorization required");
        return jsonResponse(this.revoke(tail[0]));
      }
      if (request.method === "POST" && tail.length === 2 && tail[1] === "heartbeat")
        return jsonResponse(await this.heartbeat(tail[0], bearer(request), await requestJson(request)));
      if (request.method === "GET" && tail.length === 3 && tail[1] === "jobs" && tail[2] === "poll")
        return jsonResponse({ job: await this.poll(tail[0], bearer(request)) });
      if (request.method === "POST" && tail.length === 4 && tail[1] === "jobs" && tail[3] === "result")
        return jsonResponse(await this.submitResult(tail[0], bearer(request), tail[2], await requestJson(request)));
      if (request.method === "POST" && tail.length === 4 && tail[1] === "jobs" && tail[3] === "progress")
        return jsonResponse(await this.submitProgress(tail[0], bearer(request), tail[2], await requestJson(request)));
      if (request.method === "POST" && tail.length === 2 && tail[0] === "jobs") {
        if (!context.adminAuthorized) throw new NodeHttpError(401, "owner authorization required");
        return jsonResponse(await this.enqueue(tail[1], await requestJson(request)), 202);
      }
      throw new NodeHttpError(404, "not found");
    } catch (error) {
      if (error instanceof NodeHttpError) return jsonResponse({ error: error.message }, error.status);
      console.error(error);
      return jsonResponse({ error: "internal error" }, 500);
    }
  }
}

export function nodeSchemaSql(): string[] {
  return [
    "CREATE TABLE IF NOT EXISTS node_pairings (token_hash TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)",
    "CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT NOT NULL, capabilities TEXT NOT NULL, agent_version TEXT, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT)",
    "CREATE TABLE IF NOT EXISTS node_jobs (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, lease_expires_at TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  ];
}
