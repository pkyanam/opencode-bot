/** First party browser/native pairing credentials.
 *
 * Invite and device secrets are returned only at creation/redemption time;
 * persistence contains SHA-256 digests. This module intentionally has no
 * access to owner or deployment credentials.
 */
export type PairingSql = {
  exec(query: string, ...args: unknown[]): { toArray(): unknown[]; rowsWritten?: number };
};

export type PairingOptions = { now?: () => Date; random?: (bytes: number) => Uint8Array };
export type ClientType = "web" | "native" | "expo";

const INVITE_TTL = 5 * 60_000;
const MAX_TTL = 24 * 60 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;
const MAX_CODE_ATTEMPTS = 5;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 30;

export class PairingError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(bytes: number): Uint8Array {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return value;
}

function randomToken(prefix: string, bytes = 32, random = randomBytes): string {
  return `${prefix}${hex(random(bytes))}`;
}

function humanCode(random = randomBytes): string {
  const bytes = random(CODE_LENGTH);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PairingError(400, "object required");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new PairingError(400, `${name} must be a non-empty string`);
  return value.trim();
}

function clientType(value: unknown): ClientType {
  if (value === "web" || value === "native" || value === "expo") return value;
  throw new PairingError(400, "clientType must be web, native, or expo");
}

export class PairingService {
  private readonly clock: () => Date;
  private readonly random: (bytes: number) => Uint8Array;
  constructor(private readonly sql: PairingSql, options: PairingOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
    this.init();
  }

  init(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairing_invites (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL,
      label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
      code_attempts INTEGER NOT NULL DEFAULT 0, code_locked_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairing_devices (
      id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, name TEXT NOT NULL, client_type TEXT NOT NULL,
      metadata TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairing_attempts (
      fingerprint TEXT PRIMARY KEY, window_start TEXT NOT NULL, attempts INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS pairing_devices_active ON pairing_devices(revoked_at,created_at)");
  }

  private rows<T = Record<string, unknown>>(query: string, ...args: unknown[]): T[] { return this.sql.exec(query, ...args).toArray() as T[]; }
  private one<T = Record<string, unknown>>(query: string, ...args: unknown[]): T | undefined { return this.rows<T>(query, ...args)[0]; }
  private now(): Date { return this.clock(); }

  async createInvite(input: unknown = {}): Promise<Record<string, unknown>> {
    const value = object(input);
    const ttl = value.ttlMs === undefined ? INVITE_TTL : Number(value.ttlMs);
    if (!Number.isInteger(ttl) || ttl < 10_000 || ttl > MAX_TTL) throw new PairingError(400, "ttlMs must be between 10000 and 86400000");
    const now = this.now();
    const id = randomToken("pi_", 16, this.random);
    const secret = randomToken("ps_", 32, this.random);
    const code = humanCode(this.random);
    const expires = new Date(now.getTime() + ttl).toISOString();
    const label = value.label === undefined ? null : text(value.label, "label", 160);
    this.sql.exec("INSERT INTO pairing_invites(id,secret_hash,code_hash,label,created_at,expires_at) VALUES(?,?,?,?,?,?)", id, await digest(secret), await digest(code), label, now.toISOString(), expires);
    return { inviteId: id, expiresAt: expires, code, qrSecret: secret, qrUrl: `/#pair=${encodeURIComponent(secret)}` };
  }

  private rateLimit(fingerprint: string, now: Date): void {
    this.sql.exec("DELETE FROM pairing_attempts WHERE window_start<?", new Date(now.getTime() - 60 * 60_000).toISOString());
    const key = text(fingerprint || "unknown", "fingerprint", 300);
    const row = this.one<any>("SELECT * FROM pairing_attempts WHERE fingerprint=?", key);
    const current = now.getTime();
    if (!row || current - Date.parse(String(row.window_start)) >= RATE_WINDOW) {
      this.sql.exec("INSERT INTO pairing_attempts(fingerprint,window_start,attempts) VALUES(?,?,1) ON CONFLICT(fingerprint) DO UPDATE SET window_start=excluded.window_start,attempts=1", key, now.toISOString());
      return;
    }
    if (Number(row.attempts) >= RATE_LIMIT) throw new PairingError(429, "too many pairing attempts");
    this.sql.exec("UPDATE pairing_attempts SET attempts=attempts+1 WHERE fingerprint=?", key);
  }

  async redeem(input: unknown, fingerprint = "unknown"): Promise<Record<string, unknown>> {
    const value = object(input);
    const suppliedSecret = typeof value.secret === "string" ? value.secret.trim() : "";
    const suppliedCode = typeof value.code === "string" ? value.code.trim().toUpperCase().replace(/[-\s]/g, "") : "";
    if (!suppliedSecret && !suppliedCode) throw new PairingError(401, "invalid pairing credential");
    if (suppliedSecret.length > 300 || suppliedCode.length > 64) throw new PairingError(401, "invalid pairing credential");
    const now = this.now();
    this.rateLimit(fingerprint, now);
    const bySecret = suppliedSecret ? this.one<any>("SELECT * FROM pairing_invites WHERE secret_hash=?", await digest(suppliedSecret)) : undefined;
    // The invite id lets us count incorrect human-code attempts against the
    // intended invite without ever storing or logging the plaintext code.
    const byCode = !bySecret && suppliedCode
      ? (typeof value.inviteId === "string"
        ? this.one<any>("SELECT * FROM pairing_invites WHERE id=?", value.inviteId.trim())
        : this.one<any>("SELECT * FROM pairing_invites WHERE code_hash=?", await digest(suppliedCode)))
      : undefined;
    const invite = bySecret ?? byCode;
    if (!invite || invite.used_at || Date.parse(String(invite.expires_at)) <= now.getTime() || (!bySecret && invite.code_locked_at)) throw new PairingError(401, "invalid pairing credential");
    const name = text(value.deviceName ?? value.name, "deviceName", 160);
    const type = clientType(value.clientType);
    const metadata = value.metadata === undefined ? null : JSON.stringify(object(value.metadata));
    if (metadata && metadata.length > 4096) throw new PairingError(400, "metadata is too large");
    if (!bySecret) {
      const attempts = Number(invite.code_attempts ?? 0) + 1;
      this.sql.exec("UPDATE pairing_invites SET code_attempts=?,code_locked_at=CASE WHEN ?>? THEN ? ELSE code_locked_at END WHERE id=? AND used_at IS NULL", attempts, attempts, MAX_CODE_ATTEMPTS, now.toISOString(), invite.id);
      if (attempts > MAX_CODE_ATTEMPTS || (await digest(suppliedCode)) !== String(invite.code_hash)) throw new PairingError(401, "invalid pairing credential");
    }
    const token = randomToken("dt_", 32, this.random);
    const tokenHash = await digest(token);
    const claimed = this.sql.exec("UPDATE pairing_invites SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? AND code_locked_at IS NULL", now.toISOString(), invite.id, now.toISOString());
    if (!claimed.rowsWritten) throw new PairingError(401, "invalid pairing credential");
    const deviceId = randomToken("pd_", 16, this.random);
    this.sql.exec("INSERT INTO pairing_devices(id,invite_id,name,client_type,metadata,token_hash,created_at) VALUES(?,?,?,?,?,?,?)", deviceId, invite.id, name, type, metadata, tokenHash, now.toISOString());
    return { deviceId, deviceToken: token };
  }

  listDevices(): Record<string, unknown>[] {
    return this.rows<any>("SELECT * FROM pairing_devices ORDER BY created_at").map(row => ({ id: row.id, inviteId: row.invite_id, name: row.name, deviceName: row.name, clientType: row.client_type, metadata: row.metadata ? JSON.parse(row.metadata) : null, createdAt: row.created_at, lastSeenAt: row.last_seen_at ?? undefined, revokedAt: row.revoked_at ?? undefined }));
  }

  revokeDevice(id: string): Record<string, unknown> {
    const changed = this.sql.exec("UPDATE pairing_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL", this.now().toISOString(), text(id, "deviceId", 100));
    if (!changed.rowsWritten && !this.one("SELECT id FROM pairing_devices WHERE id=?", id)) throw new PairingError(404, "device not found");
    const row = this.one<any>("SELECT * FROM pairing_devices WHERE id=?", id)!;
    return { id: row.id, revokedAt: row.revoked_at };
  }

  deleteInvite(id: string): { deleted: boolean } {
    const value = text(id, "inviteId", 100);
    const changed = this.sql.exec("DELETE FROM pairing_invites WHERE id=? AND used_at IS NULL", value);
    if (!changed.rowsWritten && !this.one("SELECT id FROM pairing_invites WHERE id=?", value)) throw new PairingError(404, "invite not found");
    return { deleted: Boolean(changed.rowsWritten) };
  }

  async authenticate(token: string | null): Promise<Record<string, unknown> | null> {
    if (!token || token.length > 300) return null;
    const row = this.one<any>("SELECT * FROM pairing_devices WHERE token_hash=? AND revoked_at IS NULL", await digest(token));
    if (!row) return null;
    const now = this.now();
    if (!row.last_seen_at || now.getTime() - Date.parse(String(row.last_seen_at)) >= 60_000)
      this.sql.exec("UPDATE pairing_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL", now.toISOString(), row.id);
    return { deviceId: row.id, name: row.name, deviceName: row.name, clientType: row.client_type, metadata: row.metadata ? JSON.parse(row.metadata) : null };
  }
}

export function pairingSchemaSql(): string[] {
  return [
    "CREATE TABLE IF NOT EXISTS pairing_invites (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0, code_locked_at TEXT)",
    "CREATE TABLE IF NOT EXISTS pairing_devices (id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, name TEXT NOT NULL, client_type TEXT NOT NULL, metadata TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT)",
    "CREATE TABLE IF NOT EXISTS pairing_attempts (fingerprint TEXT PRIMARY KEY, window_start TEXT NOT NULL, attempts INTEGER NOT NULL)",
  ];
}
