/** Workspace-owned memory. Execution nodes never own this database. */
export interface MemorySql {
  exec(
    query: string,
    ...args: any[]
  ): { toArray(): any[]; rowsWritten?: number };
}
export class MemoryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type MemoryActor = { botId?: string; threadId?: string; runId?: string };
export type MemoryItem = {
  id: string;
  botId: string | null;
  title: string;
  content: string;
  kind: string;
  tags: string[];
  visibility: "private" | "shared" | "workspace";
  sharedBotIds: string[];
  pinned: boolean;
  revision: number;
  sourceThreadId: string | null;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
};
const kinds = ["fact", "preference", "decision", "lesson", "procedure", "note"];
const visibility = ["private", "shared", "workspace"];
const access = `(m.bot_id=? OR m.visibility='workspace' OR (m.visibility='shared' AND EXISTS(SELECT 1 FROM memory_grants g WHERE g.memory_id=m.id AND g.bot_id=?)))`;
export class MemoryRegistry {
  constructor(
    private sql: MemorySql,
    private atomic: <T>(fn: () => T) => T = (fn) => fn(),
  ) {}
  init() {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS memory_registry (id TEXT PRIMARY KEY, bot_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL, tags TEXT NOT NULL, visibility TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, source_thread_id TEXT, source_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS memory_grants (memory_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(memory_id,bot_id))`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS memory_grants_bot ON memory_grants(bot_id,memory_id)`,
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS memory_registry_owner ON memory_registry(bot_id,updated_at)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS memory_versions (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision))`,
    );
    this.sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_index USING fts5(id UNINDEXED,title,content,tags, tokenize='unicode61')`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS memory_migrations (id TEXT PRIMARY KEY)`,
    );
    if (
      !this.sql
        .exec("SELECT id FROM memory_migrations WHERE id='legacy-v1'")
        .toArray().length
    )
      this.atomic(() => {
        const legacy = this.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'",
          )
          .toArray().length
          ? this.sql.exec("SELECT * FROM memory_items").toArray()
          : [];
        for (const row of legacy) {
          this.sql.exec(
            `INSERT OR IGNORE INTO memory_registry (id,bot_id,title,content,kind,tags,visibility,pinned,created_at,updated_at) VALUES (?,?,?,?,?,'[]','private',1,?,?)`,
            row.id,
            row.bot_id,
            row.content.slice(0, 100),
            row.content,
            row.kind,
            row.created_at,
            row.updated_at,
          );
          this.index(this.read(row.id));
        }
        if (legacy.length) this.sql.exec("DELETE FROM memory_items");
        this.sql.exec("INSERT INTO memory_migrations VALUES ('legacy-v1')");
      });
    const indexed = this.sql
      .exec("SELECT COUNT(*) AS n FROM memory_search_index")
      .toArray()[0].n;
    const stored = this.sql
      .exec("SELECT COUNT(*) AS n FROM memory_registry")
      .toArray()[0].n;
    if (indexed !== stored)
      this.atomic(() => {
        this.sql.exec("DELETE FROM memory_search_index");
        this.sql.exec(
          "INSERT INTO memory_search_index (id,title,content,tags) SELECT id,title,content,tags FROM memory_registry",
        );
      });
  }
  private view(row: any): MemoryItem {
    return {
      id: row.id,
      botId: row.bot_id,
      title: row.title,
      content: row.content,
      kind: row.kind,
      tags: JSON.parse(row.tags),
      visibility: row.visibility,
      sharedBotIds: row.shared_ids
        ? JSON.parse(row.shared_ids)
        : this.sql
            .exec(
              "SELECT bot_id FROM memory_grants WHERE memory_id=? ORDER BY bot_id",
              row.id,
            )
            .toArray()
            .map((g) => g.bot_id),
      pinned: Boolean(row.pinned),
      revision: row.revision,
      sourceThreadId: row.source_thread_id,
      sourceRunId: row.source_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private assertBot(botId: unknown): asserts botId is string {
    if (
      typeof botId !== "string" ||
      !this.sql.exec("SELECT id FROM bots WHERE id=?", botId).toArray().length
    )
      throw new MemoryError(400, "Choose an existing bot");
  }
  read(id: string, actor: MemoryActor = {}): MemoryItem {
    const rows = this.sql
      .exec(
        `SELECT m.* FROM memory_registry m WHERE m.id=? ${actor.botId ? `AND ${access}` : ""}`,
        id,
        ...(actor.botId ? [actor.botId, actor.botId] : []),
      )
      .toArray();
    if (!rows[0])
      throw new MemoryError(
        404,
        "Memory not found or not shared with this bot",
      );
    return this.view(rows[0]);
  }
  list(
    input: { botId?: string; q?: string; limit?: number; offset?: number } = {},
    actor: MemoryActor = {},
  ): MemoryItem[] {
    const botId = actor.botId ?? input.botId;
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 100));
    const offset = Math.max(0, Math.min(100000, Number(input.offset) || 0));
    const tokens =
      (input.q ?? "")
        .slice(0, 500)
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.slice(0, 16) ?? [];
    const match = tokens.map((t) => '"' + t + '"*').join(" OR ");
    const bindings: any[] = [];
    const where: string[] = [];
    if (botId) {
      where.push(access);
      bindings.push(botId, botId);
    }
    if (match) {
      where.push("memory_search_index MATCH ?");
      bindings.push(match);
    }
    const rows = this.sql
      .exec(
        `SELECT m.*, (SELECT json_group_array(bot_id) FROM memory_grants WHERE memory_id=m.id) AS shared_ids FROM memory_registry m ${match ? "JOIN memory_search_index ON memory_search_index.id=m.id" : ""} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${match ? "bm25(memory_search_index,0,4,1,2)," : ""} m.pinned DESC,m.updated_at DESC,m.id LIMIT ? OFFSET ?`,
        ...bindings,
        limit,
        offset,
      )
      .toArray();
    return rows.map((row) => this.view(row));
  }
  private capacity(extra: number) {
    const size = this.sql
      .exec(
        "SELECT (SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) FROM memory_registry)+(SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))),0) FROM memory_versions) AS n",
      )
      .toArray()[0].n;
    if (size + extra > 20_000_000)
      throw new MemoryError(
        409,
        "Memory storage limit reached. Export and remove unused memories before adding more.",
      );
  }
  private fields(input: any, previous?: MemoryItem) {
    const content = input.content ?? previous?.content;
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 16000
    )
      throw new MemoryError(
        400,
        "Memory content must contain 1–16000 characters",
      );
    const title =
      input.title ?? previous?.title ?? content.split("\n")[0].slice(0, 100);
    if (typeof title !== "string" || !title.trim() || title.length > 160)
      throw new MemoryError(400, "Title must contain 1–160 characters");
    const kind = input.kind ?? previous?.kind ?? "fact";
    if (!kinds.includes(kind))
      throw new MemoryError(400, "Unknown memory kind");
    const scope = input.visibility ?? previous?.visibility ?? "private";
    if (!visibility.includes(scope))
      throw new MemoryError(400, "Unknown sharing scope");
    const tags = input.tags ?? previous?.tags ?? [];
    if (
      !Array.isArray(tags) ||
      tags.length > 12 ||
      tags.some((t) => typeof t !== "string" || !t.trim() || t.length > 48)
    )
      throw new MemoryError(400, "Use up to 12 short tags");
    const grants = input.sharedBotIds ?? previous?.sharedBotIds ?? [];
    if (!Array.isArray(grants) || grants.length > 100)
      throw new MemoryError(400, "Invalid shared bot list");
    grants.forEach((g) => this.assertBot(g));
    if (scope === "shared" && !grants.length)
      throw new MemoryError(400, "Choose at least one bot to share with");
    const pinned = input.pinned ?? previous?.pinned ?? false;
    if (typeof pinned !== "boolean")
      throw new MemoryError(400, "Pinned must be a boolean");
    return {
      content: content.trim(),
      title: title.trim(),
      kind,
      tags: [...new Set(tags.map((t) => t.trim()))],
      visibility: scope,
      sharedBotIds:
        scope === "shared" ? ([...new Set(grants)] as string[]) : [],
      pinned,
    };
  }
  create(input: any, actor: MemoryActor = {}): MemoryItem {
    const botId = actor.botId ?? input.botId;
    this.assertBot(botId);
    const fields = this.fields(input);
    const now = new Date().toISOString();
    const item: MemoryItem = {
      ...fields,
      id: "mem_" + crypto.randomUUID(),
      botId,
      revision: 1,
      sourceThreadId: actor.threadId ?? null,
      sourceRunId: actor.runId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    // Identical writes by a retry return the existing record, without broadening its scope.
    const prior = this.sql
      .exec(
        "SELECT id FROM memory_registry WHERE bot_id=? AND content=? AND title=? AND kind=? AND tags=? AND visibility=? AND pinned=?",
        botId,
        item.content,
        item.title,
        item.kind,
        JSON.stringify(item.tags),
        item.visibility,
        item.pinned ? 1 : 0,
      )
      .toArray()
      .find(
        (r) =>
          JSON.stringify(this.read(r.id).sharedBotIds) ===
          JSON.stringify([...item.sharedBotIds].sort()),
      );
    if (prior) return this.read(prior.id, actor);
    const count = this.sql
      .exec("SELECT COUNT(*) AS n FROM memory_registry")
      .toArray()[0].n;
    if (count >= 10000)
      throw new MemoryError(
        409,
        "Memory registry limit reached (10,000). Export or remove unused memories.",
      );
    this.capacity(
      new TextEncoder().encode(item.content + JSON.stringify(item)).length,
    );
    return this.atomic(() => {
      this.sql.exec(
        "INSERT INTO memory_registry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        item.id,
        botId,
        item.title,
        item.content,
        item.kind,
        JSON.stringify(item.tags),
        item.visibility,
        item.pinned ? 1 : 0,
        1,
        item.sourceThreadId,
        item.sourceRunId,
        now,
        now,
      );
      this.grants(item);
      this.index(item);
      this.version(item, actor);
      return item;
    });
  }
  private writable(id: string, actor: MemoryActor, revision: unknown) {
    const item = this.read(id, actor);
    if (actor.botId && actor.botId !== item.botId)
      throw new MemoryError(
        403,
        "Shared memories are read-only. Ask their owner to change them, or save your own memory.",
      );
    if (revision !== item.revision)
      throw new MemoryError(
        409,
        "Memory changed. Read the latest version before saving.",
      );
    return item;
  }
  update(id: string, input: any, actor: MemoryActor = {}): MemoryItem {
    const previous = this.writable(id, actor, input.revision);
    const fields = this.fields(input, previous);
    const item: MemoryItem = {
      ...previous,
      ...fields,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.capacity(
      Math.max(
        0,
        new TextEncoder().encode(item.content).length -
          new TextEncoder().encode(previous.content).length,
      ) + new TextEncoder().encode(JSON.stringify(item)).length,
    );
    return this.atomic(() => {
      this.sql.exec(
        "UPDATE memory_registry SET title=?,content=?,kind=?,tags=?,visibility=?,pinned=?,revision=?,updated_at=? WHERE id=?",
        item.title,
        item.content,
        item.kind,
        JSON.stringify(item.tags),
        item.visibility,
        item.pinned ? 1 : 0,
        item.revision,
        item.updatedAt,
        id,
      );
      this.grants(item);
      this.index(item);
      this.version(item, actor);
      return item;
    });
  }
  remove(id: string, actor: MemoryActor = {}, revision?: unknown) {
    // Legacy owner clients may delete without a revision; agent writes must always compare versions.
    const current = this.read(id, actor);
    this.writable(
      id,
      actor,
      revision ?? (!actor.botId ? current.revision : undefined),
    );
    return this.atomic(() => {
      for (const table of ["memory_grants", "memory_versions"])
        this.sql.exec(`DELETE FROM ${table} WHERE memory_id=?`, id);
      this.sql.exec("DELETE FROM memory_search_index WHERE id=?", id);
      this.sql.exec("DELETE FROM memory_registry WHERE id=?", id);
      if (
        this.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'",
          )
          .toArray().length
      )
        this.sql.exec("DELETE FROM memory_items WHERE id=?", id);
      return { deleted: true, id };
    });
  }
  history(id: string, actor: MemoryActor = {}) {
    const item = this.read(id, actor);
    if (actor.botId && actor.botId !== item.botId)
      throw new MemoryError(
        403,
        "Only the owner can inspect private memory history",
      );
    return this.sql
      .exec(
        "SELECT snapshot,actor,created_at FROM memory_versions WHERE memory_id=? ORDER BY revision DESC LIMIT 20",
        id,
      )
      .toArray()
      .map((r) => ({ ...JSON.parse(r.snapshot), actor: r.actor }));
  }
  deleteBot(botId: string) {
    const owned = this.sql
      .exec("SELECT id,visibility FROM memory_registry WHERE bot_id=?", botId)
      .toArray();
    for (const row of owned) {
      if (row.visibility === "private") this.remove(row.id);
      else {
        this.sql.exec(
          "UPDATE memory_registry SET bot_id=NULL WHERE id=?",
          row.id,
        );
        this.sql.exec("DELETE FROM memory_versions WHERE memory_id=?", row.id);
      }
    }
    this.sql.exec("DELETE FROM memory_grants WHERE bot_id=?", botId);
    return owned.filter((r) => r.visibility === "private").length;
  }
  recall(botId: string, query: string, budget = 6000): MemoryItem[] {
    const candidates = [
      ...this.list({ botId, limit: 20 }).filter((m) => m.pinned),
      ...this.list({ botId, q: query, limit: 12 }),
    ];
    const seen = new Set<string>();
    const selected: MemoryItem[] = [];
    let used = 0;
    for (const item of candidates) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const size = item.content.length + item.title.length + 100;
      if (used + size > budget) continue;
      selected.push(item);
      used += size;
    }
    return selected;
  }
  private grants(item: MemoryItem) {
    this.sql.exec("DELETE FROM memory_grants WHERE memory_id=?", item.id);
    for (const botId of item.sharedBotIds)
      this.sql.exec("INSERT INTO memory_grants VALUES (?,?)", item.id, botId);
  }
  private index(item: MemoryItem) {
    this.sql.exec("DELETE FROM memory_search_index WHERE id=?", item.id);
    this.sql.exec(
      "INSERT INTO memory_search_index (id,title,content,tags) VALUES (?,?,?,?)",
      item.id,
      item.title,
      item.content,
      item.tags.join(" "),
    );
  }
  private version(item: MemoryItem, actor: MemoryActor) {
    this.sql.exec(
      "INSERT INTO memory_versions VALUES (?,?,?,?,?)",
      item.id,
      item.revision,
      JSON.stringify(item),
      actor.botId ?? "owner",
      item.updatedAt,
    );
    this.sql.exec(
      "DELETE FROM memory_versions WHERE memory_id=? AND revision<=?",
      item.id,
      item.revision - 20,
    );
  }
}
