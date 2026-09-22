import { MemoryError, type MemorySql } from "./memory-registry";

type QueryKind = "recall" | "reflect";
type QueryEngine = { query(botId: string, kind: QueryKind, query: string, budget?: string): Promise<Record<string, unknown>> };
type JobRow = {
  id: string;
  bot_id: string;
  kind: QueryKind;
  query: string;
  budget: string;
  authorization: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

const TTL_MS = 15 * 60_000;
const QUEUED_TIMEOUT_MS = 60_000;
const RUNNING_TIMEOUT_MS = 11 * 60_000;
const QUERY_RETRY_MS = 3_000;
const QUERY_DEADLINE_MS = 5 * 60_000;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_QUERY = 8_000;
const validKind = (kind: unknown): kind is QueryKind => kind === "recall" || kind === "reflect";
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 600) : "Memory query failed";

/** Durable asynchronous wrapper for long Hindsight recall/reflection calls. The
 * caller remains responsible for authenticating the owner/paired request. */
export class MemoryQueryJobs {
  constructor(
    private readonly sql: MemorySql,
    private readonly engine: QueryEngine,
    private readonly authorization: (botId: string) => string,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS hindsight_query_jobs (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL,
      query TEXT NOT NULL, budget TEXT NOT NULL, authorization TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  create(botId: string, kind: unknown, query: unknown, budget: unknown = "mid") {
    if (!validKind(kind)) throw new MemoryError(400, "Memory query kind must be recall or reflect.");
    const text = String(query ?? "").trim();
    if (!text || text.length > MAX_QUERY) throw new MemoryError(400, "Enter a memory question of up to 8,000 characters.");
    if (budget !== "low" && budget !== "mid" && budget !== "high") throw new MemoryError(400, "Memory budget must be low, mid, or high.");
    const authorization = this.authorization(botId);
    const active = this.sql.exec("SELECT id FROM hindsight_query_jobs WHERE bot_id=? AND status IN ('queued','running') AND expires_at>? ORDER BY created_at DESC LIMIT 1", botId, this.now()).toArray()[0] as { id?: string } | undefined;
    if (active?.id) return this.get(active.id);
    const id = this.id(), now = this.now();
    this.sql.exec(
      "INSERT INTO hindsight_query_jobs (id,bot_id,kind,query,budget,authorization,status,result,error,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)",
      id, botId, kind, text, budget, authorization, "queued", now, now, now + TTL_MS,
    );
    return this.public(this.row(id)!);
  }

  get(id: string) {
    const row = this.row(id);
    if (!row) throw new MemoryError(404, "Memory query job not found.");
    if (row.expires_at <= this.now()) {
      this.sql.exec("DELETE FROM hindsight_query_jobs WHERE id=?", id);
      throw new MemoryError(404, "Memory query job expired.");
    }
    const stale = row.status === "queued"
      ? row.updated_at + QUEUED_TIMEOUT_MS <= this.now()
      : row.status === "running" && row.updated_at + RUNNING_TIMEOUT_MS <= this.now();
    if (stale) {
      this.sql.exec("UPDATE hindsight_query_jobs SET status='failed',result=NULL,error=?,updated_at=? WHERE id=? AND status IN ('queued','running')", "Memory query timed out; retry the query.", this.now(), id);
      return this.public(this.row(id)!);
    }
    if (["queued", "running", "succeeded"].includes(row.status) && this.authorization(row.bot_id) !== row.authorization) {
      this.sql.exec("UPDATE hindsight_query_jobs SET status='failed',result=NULL,error=?,updated_at=? WHERE id=? AND status IN ('queued','running','succeeded')", "Memory authorization changed; retry the query.", this.now(), id);
      return this.public(this.row(id)!);
    }
    return this.public(this.row(id)!);
  }

  latest(botId: string) {
    this.authorization(botId);
    const row = this.sql.exec("SELECT id FROM hindsight_query_jobs WHERE bot_id=? ORDER BY created_at DESC LIMIT 1", botId).toArray()[0] as { id?: string } | undefined;
    return row?.id ? this.get(row.id) : null;
  }

  cancel(id: string) {
    const row = this.row(id);
    if (!row) throw new MemoryError(404, "Memory query job not found.");
    if (row.expires_at <= this.now()) throw new MemoryError(404, "Memory query job expired.");
    this.sql.exec("UPDATE hindsight_query_jobs SET status='cancelled',result=NULL,error=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')", this.now(), id);
    return this.public(this.row(id)!);
  }

  /** Claim is atomic, so an alarm/reload cannot execute a job twice. */
  async run(id: string) {
    const now = this.now();
    const claimed = this.sql.exec("UPDATE hindsight_query_jobs SET status='running',updated_at=? WHERE id=? AND status='queued' AND expires_at>?", now, id, now).rowsWritten;
    if (!claimed) return this.row(id) ? this.public(this.row(id)!) : undefined;
    const row = this.row(id)!;
    try {
      const started = this.now();
      let result: Record<string, unknown>;
      for (;;) {
        try {
          result = await this.engine.query(row.bot_id, row.kind, row.query, row.budget);
          break;
        } catch (error) {
          const message = safeError(error).toLowerCase();
          const retryable = (error as any)?.status === 409 || (error as any)?.status === 503;
          const warmup = message.includes("starting") || message.includes("indexing") || message.includes("temporarily unavailable");
          const current = this.row(id);
          if (!retryable || !warmup || !current || current.status !== "running" || this.now() - started >= QUERY_DEADLINE_MS) throw error;
          await this.sleep(QUERY_RETRY_MS);
          const afterSleep = this.row(id);
          if (!afterSleep || afterSleep.status !== "running") return afterSleep ? this.public(afterSleep) : undefined;
        }
      }
      const latest = this.row(id);
      if (!latest || latest.status !== "running") return latest ? this.public(latest) : undefined;
      if (latest.updated_at + RUNNING_TIMEOUT_MS <= this.now()) {
        this.sql.exec("UPDATE hindsight_query_jobs SET status='failed',result=NULL,error=?,updated_at=? WHERE id=? AND status='running'", "Memory query timed out; retry the query.", this.now(), id);
        return this.public(this.row(id)!);
      }
      if (this.authorization(row.bot_id) !== row.authorization) {
        this.sql.exec("UPDATE hindsight_query_jobs SET status='failed',result=NULL,error=?,updated_at=? WHERE id=? AND status='running'", "Memory authorization changed; retry the query.", this.now(), id);
      } else {
        const serialized = JSON.stringify(result);
        if (new TextEncoder().encode(serialized).byteLength > MAX_RESULT_BYTES) throw new Error("Memory query result exceeded the 512 KiB limit; narrow the question and retry.");
        this.sql.exec("UPDATE hindsight_query_jobs SET status='succeeded',result=?,error=NULL,updated_at=? WHERE id=? AND status='running'", serialized, this.now(), id);
      }
    } catch (error) {
      this.sql.exec("UPDATE hindsight_query_jobs SET status='failed',result=NULL,error=?,updated_at=? WHERE id=? AND status='running'", safeError(error), this.now(), id);
    }
    const finished = this.row(id);
    return finished ? this.public(finished) : undefined;
  }

  purge() {
    return this.sql.exec("DELETE FROM hindsight_query_jobs WHERE expires_at<=?", this.now()).rowsWritten;
  }

  private row(id: string): JobRow | undefined { return this.sql.exec("SELECT * FROM hindsight_query_jobs WHERE id=?", id).toArray()[0] as JobRow | undefined; }
  private public(row: JobRow) {
    return { id: row.id, botId: row.bot_id, kind: row.kind, query: row.query, budget: row.budget, status: row.status, result: row.status === "succeeded" && row.result ? JSON.parse(row.result) : undefined, error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
  }
}
