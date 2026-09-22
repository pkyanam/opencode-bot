import { redactHindsightText } from "./hindsight-redaction";
import {
  MemoryError,
  MemoryRegistry,
  type MemorySql,
  type MemoryItem,
} from "./memory-registry";
import {
  HindsightClient,
  HindsightError,
  type RetainItem,
} from "./hindsight-client";

export type HindsightSettings = {
  enabled: boolean;
  autoCapture: boolean;
  url: string;
  apiKey?: string;
  since: string;
};
type Projection = {
  bot_id: string;
  bank_id: string;
  manifest: string;
  target: string;
  operations: string;
  status: string;
  error: string | null;
  updated_at: string;
};
type PendingOperation = {
  id: string;
  manifest: Record<string, number>;
  items: RetainItem[];
  submitted?: boolean;
};
type EngineOptions = {
  sql: MemorySql;
  registry: MemoryRegistry;
  client: (settings: HindsightSettings) => HindsightClient;
  schedule: () => void;
  nativeReady?: () => boolean;
};
const defaults = (): HindsightSettings => ({
  enabled: false,
  autoCapture: true,
  url: "",
  since: new Date().toISOString(),
});
const plainError = (error: unknown) =>
  error instanceof Error
    ? error.message.slice(0, 600)
    : "Hindsight request failed";
const budgetValue = (value: unknown): "low" | "mid" | "high" =>
  value === "low" || value === "high" ? value : "mid";
/** Registry grants are authoritative. Each bot has an isolated projection bank.
 * Corrections/revocations rotate the bank before retrieval; old derived knowledge
 * can never sneak through observations, reflection, or mental models. */
export class HindsightEngine {
  private syncing?: Promise<void>;
  private generation = 0;
  constructor(private options: EngineOptions) {
    const sql = options.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS hindsight_settings (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS hindsight_projections (bot_id TEXT PRIMARY KEY,bank_id TEXT NOT NULL,manifest TEXT NOT NULL,target TEXT NOT NULL,operations TEXT NOT NULL,status TEXT NOT NULL,error TEXT,updated_at TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS hindsight_garbage (bank_id TEXT PRIMARY KEY)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS hindsight_models (id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,name TEXT NOT NULL,query TEXT NOT NULL,remote_id TEXT,bank_id TEXT,operation_id TEXT,status TEXT NOT NULL DEFAULT 'pending',error TEXT)`,
    );
    for (const column of [
      "operation_id TEXT",
      "status TEXT NOT NULL DEFAULT 'pending'",
      "error TEXT",
    ])
      try {
        sql.exec(`ALTER TABLE hindsight_models ADD COLUMN ${column}`);
      } catch {
        /* Existing column. */
      }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS hindsight_captures (run_id TEXT PRIMARY KEY,memory_id TEXT NOT NULL)`,
    );
    if (
      !sql.exec("SELECT value FROM hindsight_settings WHERE id=1").toArray()
        .length
    )
      sql.exec(
        "INSERT INTO hindsight_settings VALUES (1,?)",
        JSON.stringify({
          ...defaults(),
          enabled: Boolean(options.nativeReady?.()),
        }),
      );
  }
  settings(): HindsightSettings {
    const row = this.options.sql
      .exec("SELECT value FROM hindsight_settings WHERE id=1")
      .toArray()[0];
    return row ? JSON.parse(row.value) : defaults();
  }
  configure(input: any) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new MemoryError(400, "Invalid Hindsight settings.");
    const allowed = new Set(["url", "apiKey", "enabled", "autoCapture"]);
    const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
    if (unsupported.length)
      throw new MemoryError(
        400,
        `Unsupported Hindsight setting: ${unsupported[0]}`,
      );
    const current = this.settings();
    const endpointChanged =
      input.url !== undefined &&
      String(input.url).trim().replace(/\/+$/, "") !== current.url;
    if (input.url !== undefined) {
      if (typeof input.url !== "string")
        throw new MemoryError(400, "Hindsight URL must be a string.");
      const raw = input.url.trim().replace(/\/+$/, "");
      if (raw) {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new MemoryError(400, "Use a valid HTTPS Hindsight URL.");
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol === "http:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
          throw new MemoryError(
            400,
            "Use an HTTPS Hindsight URL (HTTP is allowed only for localhost).",
          );
      }
      current.url = raw;
    }
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== "string")
        throw new MemoryError(400, "Hindsight API key must be a string.");
      current.apiKey = input.apiKey.trim();
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean")
        throw new MemoryError(400, "Hindsight enabled must be a boolean.");
      current.enabled = input.enabled;
    }
    if (input.autoCapture !== undefined) {
      if (typeof input.autoCapture !== "boolean")
        throw new MemoryError(400, "Hindsight auto-capture must be a boolean.");
      current.autoCapture = input.autoCapture;
    }
    const previous = this.settings();
    if (endpointChanged && input.apiKey === undefined) delete current.apiKey;
    if (previous.url !== current.url) {
      this.generation++;
      this.options.sql.exec("DELETE FROM hindsight_projections");
      // Bank IDs belong to the previous endpoint. Never send them to the newly configured
      // server; the old endpoint may be gone, and a reused ID could delete unrelated data.
      this.options.sql.exec("DELETE FROM hindsight_garbage");
      this.options.sql.exec(
        "UPDATE hindsight_models SET remote_id=NULL,bank_id=NULL",
      );
    }
    this.options.sql.exec(
      "INSERT OR REPLACE INTO hindsight_settings VALUES (1,?)",
      JSON.stringify(current),
    );
    this.options.schedule();
    return this.status();
  }
  status() {
    const config = this.settings(),
      rows = this.options.sql
        .exec("SELECT * FROM hindsight_projections")
        .toArray();
    const botCount = Number(
      this.options.sql.exec("SELECT COUNT(*) AS n FROM bots").toArray()[0].n,
    );
    const failed = rows.filter((r) => r.status === "failed").length,
      pending = rows.filter(
        (r) => r.status !== "ready" && r.status !== "failed",
      ).length;
    return {
      provider: "hindsight",
      configured: Boolean(config.url || this.options.nativeReady?.()),
      enabled: config.enabled,
      status: !config.enabled
        ? "disabled"
        : failed
          ? "unavailable"
          : pending || rows.length < botCount || !rows.length
            ? "starting"
            : config.url || this.options.nativeReady?.()
              ? "ready"
              : "unavailable",
      error:
        rows.find((r) => r.error)?.error ??
        (!config.url && !this.options.nativeReady?.()
          ? "Built-in Hindsight is not available on this deployment. Update the Computer image or configure an external Hindsight server."
          : undefined),
      pending,
      failed,
      settings: {
        url: config.url,
        model: config.url
          ? "Configured by your Hindsight server"
          : "@cf/zai-org/glm-5.3-flash",
        autoCapture: config.autoCapture,
      },
      capabilities: [
        "retain",
        "recall",
        "reflect",
        "observations",
        "mental_models",
      ],
    };
  }
  private records(botId: string): MemoryItem[] {
    const all: MemoryItem[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = this.options.registry.list({ botId, limit: 200, offset });
      all.push(...page);
      if (page.length < 200) break;
    }
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }
  private manifest(items: MemoryItem[]) {
    return Object.fromEntries(items.map((m) => [m.id, m.revision]));
  }
  private projection(botId: string): Projection | undefined {
    return this.options.sql
      .exec("SELECT * FROM hindsight_projections WHERE bot_id=?", botId)
      .toArray()[0];
  }
  private hasPendingModels(botId: string, bankId: string) {
    return this.options.sql.exec("SELECT 1 FROM hindsight_models WHERE bot_id=? AND bank_id=? AND (status IN (?,?) OR operation_id IS NOT NULL) LIMIT 1", botId, bankId, "pending", "creating").toArray().length > 0;
  }
  private assertBot(botId: string) {
    if (
      !this.options.sql.exec("SELECT id FROM bots WHERE id=?", botId).toArray()
        .length
    )
      throw new MemoryError(404, "Bot not found");
  }
  private update(row: Projection) {
    this.options.sql.exec(
      "INSERT OR REPLACE INTO hindsight_projections VALUES (?,?,?,?,?,?,?,?)",
      row.bot_id,
      row.bank_id,
      row.manifest,
      row.target,
      row.operations,
      row.status,
      row.error,
      new Date().toISOString(),
    );
  }
  /** Invoked after mutations as well as before every read. No stale-bank window. */
  invalidate() {
    if (this.settings().enabled) this.options.schedule();
  }
  reindex() {
    this.generation++;
    for (const row of this.options.sql
      .exec("SELECT bank_id FROM hindsight_projections")
      .toArray())
      this.options.sql.exec(
        "INSERT OR IGNORE INTO hindsight_garbage VALUES (?)",
        row.bank_id,
      );
    this.options.sql.exec("DELETE FROM hindsight_projections");
    this.options.schedule();
    return { queued: true };
  }
  /** Called when the native Hindsight instance is replaced. Rebuild projections while retaining
   * authoritative model definitions; old banks are garbage-collected asynchronously. */
  instanceChanged(instanceId: string) {
    const previous = this.options.sql
      .exec("SELECT value FROM hindsight_settings WHERE id=1")
      .toArray()[0];
    const settings = this.settings();
    if (previous && JSON.parse(previous.value).instanceId === instanceId)
      return { changed: false };
    this.generation++;
    for (const row of this.options.sql
      .exec("SELECT bank_id FROM hindsight_projections")
      .toArray())
      this.options.sql.exec(
        "INSERT OR IGNORE INTO hindsight_garbage VALUES (?)",
        row.bank_id,
      );
    this.options.sql.exec("DELETE FROM hindsight_projections");
    this.options.sql.exec(
      "UPDATE hindsight_models SET remote_id=NULL,bank_id=NULL",
    );
    this.options.sql.exec(
      "INSERT OR REPLACE INTO hindsight_settings VALUES (1,?)",
      JSON.stringify({ ...settings, instanceId }),
    );
    this.options.schedule();
    return { changed: true };
  }
  engineInstanceChanged(instanceId: string) {
    return this.instanceChanged(instanceId);
  }
  async tick() {
    if (this.syncing) return this.syncing;
    this.syncing = this.sync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  private async sync() {
    const generation = this.generation;
    const config = this.settings();
    if (!config.enabled) return;
    const client = this.options.client(config),
      bots = this.options.sql.exec("SELECT id,name FROM bots").toArray();
    for (const row of this.options.sql
      .exec("SELECT * FROM hindsight_projections")
      .toArray())
      if (!bots.some((b) => b.id === row.bot_id)) {
        this.options.sql.exec(
          "INSERT OR IGNORE INTO hindsight_garbage VALUES (?)",
          row.bank_id,
        );
        this.options.sql.exec(
          "DELETE FROM hindsight_projections WHERE bot_id=?",
          row.bot_id,
        );
        this.options.sql.exec(
          "DELETE FROM hindsight_models WHERE bot_id=?",
          row.bot_id,
        );
      }
    // Limit each alarm's work. Long extraction runs happen asynchronously in Hindsight.
    for (const bot of bots) {
      const items = this.records(bot.id),
        target = this.manifest(items),
        targetJson = JSON.stringify(target);
      let row = this.projection(bot.id);
      if (row?.status === "ready" && row.manifest === targetJson) {
        try { await this.syncModels(row, client); } catch (error) {
          // A malformed model row must not abort projection synchronization for every bot.
          this.options.sql.exec("UPDATE hindsight_models SET status=?,error=? WHERE bot_id=? AND bank_id=? AND status<>?", "failed", plainError(error), bot.id, row.bank_id, "ready");
        }
        if (this.hasPendingModels(bot.id, row.bank_id)) this.options.schedule();
        continue;
      }
      if (
        row?.status === "failed" &&
        Date.now() - Date.parse(row.updated_at) < 30000
      ) {
        this.options.schedule();
        continue;
      }
      if (row?.status === "failed") {
        row.status = row.manifest === "{}" ? "new" : "indexing";
        row.error = null;
        this.update(row);
      }
      const previous = JSON.parse(row?.target ?? "{}");
      const revoked = Object.keys(previous).some(
        (id) => target[id] !== previous[id],
      );
      if (!row || revoked) {
        if (row)
          this.options.sql.exec(
            "INSERT OR IGNORE INTO hindsight_garbage VALUES (?)",
            row.bank_id,
          );
        row = {
          bot_id: bot.id,
          bank_id: `ocbot_${bot.id.replace(/[^a-zA-Z0-9_]/g, "_")}_${crypto.randomUUID().replaceAll("-", "")}`,
          manifest: "{}",
          target: targetJson,
          operations: "[]",
          status: "new",
          error: null,
          updated_at: new Date().toISOString(),
        };
        this.update(row);
      }
      try {
        if (row.status === "new") {
          await client.createBank(row.bank_id, bot.name);
          // An instance replacement can invalidate this projection while the remote call is
          // in flight. Do not resurrect the old bank by writing the stale local row back.
          const current = this.projection(bot.id);
          if (!current || current.bank_id !== row.bank_id) {
            this.options.schedule();
            return;
          }
          row.status = "indexing";
          this.update(row);
        }
        let operations: PendingOperation[] = JSON.parse(row.operations);
        if (operations.length) {
          const op = operations[0];
          if (op.submitted !== false) {
            try {
              const result = (await client.operation(row.bank_id, op.id)) as {
                status: string;
              };
              if (generation !== this.generation || this.projection(bot.id)?.bank_id !== row.bank_id) {
                this.options.schedule();
                return;
              }
              const state = result.status;
              if (["failed", "cancelled"].includes(state))
                throw new Error(
                  "Hindsight retain failed. Check the memory engine model connection and retry synchronization.",
                );
              if (!["completed", "succeeded"].includes(state)) {
                this.options.schedule();
                return;
              }
              row.manifest = JSON.stringify({
                ...JSON.parse(row.manifest),
                ...op.manifest,
              });
              operations.shift();
              row.operations = JSON.stringify(operations);
              this.update(row);
            } catch (error) {
              // A crash can leave the local intent before the POST reaches Hindsight. A 404
              // means the idempotency key is unknown remotely; retry the same POST, never poll
              // forever. Other errors remain retryable through the normal failed state.
              if (error instanceof HindsightError && error.status === 404) {
                op.submitted = false;
                row.operations = JSON.stringify(operations);
                this.update(row);
              } else throw error;
            }
          }
        }
        const known = JSON.parse(row.manifest);
        const remaining = items
          .filter((m) => known[m.id] !== m.revision)
          .slice(0, 8);
        if (remaining.length) {
          // Persist operation identity before submission so a lost acknowledgement retries idempotently.
          let submission = operations[0];
          if (!submission) {
            const payload = remaining.map((m) => ({
              content: `${m.title}\n\n${m.content}`,
              document_id: m.id,
              context: `${m.kind}; author=${m.botId ?? "archived"}; sourceThread=${m.sourceThreadId ?? "manual"}`,
              timestamp: m.updatedAt,
              tags: [`source:${m.id}`, `revision:${m.revision}`, ...m.tags],
              metadata: { registry_id: m.id, revision: String(m.revision) },
            }));
            submission = {
              id: crypto.randomUUID(),
              manifest: this.manifest(remaining),
              items: payload,
              submitted: false,
            };
            row.operations = JSON.stringify([submission]);
            row.target = targetJson;
            this.update(row);
          }
          const retained = (await client.retain(
            row.bank_id,
            submission.items,
            submission.id,
          )) as { operation_id?: string };
          if (generation !== this.generation || this.projection(bot.id)?.bank_id !== row.bank_id) {
            this.options.schedule();
            return;
          }
          submission.submitted = true;
          row.operations = JSON.stringify([submission]);
          this.update(row);
          if (!retained.operation_id) {
            row.manifest = JSON.stringify({ ...known, ...submission.manifest });
            row.operations = "[]";
            this.update(row);
          }
          this.options.schedule();
          return;
        }
        row.status = "ready";
        row.error = null;
        row.target = targetJson;
        row.manifest = targetJson;
        this.update(row);
        await this.syncModels(row, client, generation);
        if (this.hasPendingModels(bot.id, row.bank_id)) this.options.schedule();
        if (bots.some((other) => other.id !== bot.id && (() => { const p = this.projection(other.id); return !p || p.status !== "ready" || p.manifest !== JSON.stringify(this.manifest(this.records(other.id))); })())) this.options.schedule();
        return;
      } catch (error) {
        if (generation !== this.generation || this.projection(bot.id)?.bank_id !== row.bank_id) {
          this.options.schedule();
          return;
        }
        row.status = "failed";
        row.error = plainError(error);
        this.update(row);
        this.options.schedule();
        return;
      }
    }
    const garbage = this.options.sql
      .exec("SELECT bank_id FROM hindsight_garbage LIMIT 1")
      .toArray()[0];
    if (garbage) {
      try {
        await client.deleteBank(garbage.bank_id);
        this.options.sql.exec(
          "DELETE FROM hindsight_garbage WHERE bank_id=?",
          garbage.bank_id,
        );
        if (this.options.sql.exec("SELECT 1 FROM hindsight_garbage LIMIT 1").toArray().length)
          this.options.schedule();
      } catch (error) {
        if (error instanceof HindsightError && error.status === 404)
          this.options.sql.exec(
            "DELETE FROM hindsight_garbage WHERE bank_id=?",
            garbage.bank_id,
          ); /* Other failures remain queued. */
        if (error instanceof HindsightError && error.status === 404 && this.options.sql.exec("SELECT 1 FROM hindsight_garbage LIMIT 1").toArray().length) this.options.schedule();
      }
    }
  }
  private ready(botId: string) {
    this.assertBot(botId);
    if (!this.settings().enabled)
      throw new MemoryError(409, "Enable Hindsight in Memory settings first.");
    const row = this.projection(botId),
      expected = JSON.stringify(this.manifest(this.records(botId)));
    if (!row || row.status !== "ready" || row.manifest !== expected) {
      this.options.schedule();
      throw new MemoryError(
        409,
        "Hindsight is indexing the latest authorized memories. Try again shortly.",
      );
    }
    return row;
  }
  async query(
    botId: string,
    kind: "recall" | "reflect",
    query: unknown,
    budget?: unknown,
  ) {
    const text = String(query ?? "").trim();
    if (!text || text.length > 8000)
      throw new MemoryError(
        400,
        "Enter a memory question of up to 8,000 characters.",
      );
    const row = this.ready(botId),
      client = this.options.client(this.settings());
    const result =
      kind === "recall"
        ? await client.recall(row.bank_id, text, budgetValue(budget))
        : await client.reflect(row.bank_id, text, budgetValue(budget));
    // Re-check grants after remote work: revocation may have occurred during reflection.
    if (this.ready(botId).bank_id !== row.bank_id)
      throw new MemoryError(409, "Memory access changed; retry the query.");
    return { provider: "hindsight", ...(result as Record<string, unknown>) };
  }
  async observations(botId: string) {
    const row = this.ready(botId);
    const result = await this.options
      .client(this.settings())
      .observations(row.bank_id);
    if (this.ready(botId).bank_id !== row.bank_id)
      throw new MemoryError(409, "Memory access changed");
    return result;
  }
  async models(botId: string) {
    const row = this.ready(botId);
    const result = (await this.options
      .client(this.settings())
      .mentalModels(row.bank_id)) as { items?: unknown[] };
    if (this.ready(botId).bank_id !== row.bank_id)
      throw new MemoryError(409, "Memory access changed");
    const local = this.options.sql
      .exec(
        "SELECT id,name,query,status,error,operation_id FROM hindsight_models WHERE bot_id=? AND bank_id=?",
        botId,
        row.bank_id,
      )
      .toArray();
    return {
      ...result,
      items: (result.items ?? []).map((item: any) => {
        const match = local.find(
          (model) =>
            model.id === item.id ||
            model.id === item.mental_model_id ||
            model.id === item.remote_id,
        );
        return match
          ? {
              ...item,
              local_id: match.id,
              local_status: match.status,
              local_error: match.error,
              operation_id: match.operation_id,
            }
          : item;
      }),
    };
  }
  async createModel(botId: string, input: any) {
    const row = this.ready(botId);
    const name = String(input.name ?? "").trim(),
      query = String(input.query ?? "").trim();
    if (!name || name.length > 160 || !query || query.length > 8000)
      throw new MemoryError(400, "A model requires a name and a question.");
    const id = crypto.randomUUID();
    this.options.sql.exec(
      "INSERT INTO hindsight_models (id,bot_id,name,query,remote_id,bank_id,operation_id,status,error) VALUES (?,?,?,?,NULL,?,NULL,?,NULL)",
      id,
      botId,
      name,
      query,
      row.bank_id,
      "pending",
    );
    await this.syncModels(row, this.options.client(this.settings()));
    this.options.schedule();
    const model = this.options.sql
      .exec("SELECT * FROM hindsight_models WHERE id=?", id)
      .toArray()[0];
    return { id, name, query, status: model.status, error: model.error };
  }
  private async syncModels(row: Projection, client: HindsightClient, generation = this.generation) {
    for (const model of this.options.sql
      .exec("SELECT * FROM hindsight_models WHERE bot_id=?", row.bot_id)
      .toArray()) {
      if (model.bank_id === row.bank_id && model.operation_id) {
        try {
          const op = (await client.operation(
            row.bank_id,
            model.operation_id,
          )) as { status?: string };
          if (generation !== this.generation || this.projection(row.bot_id)?.bank_id !== row.bank_id) return;
          if (["failed", "cancelled"].includes(String(op.status))) {
            this.options.sql.exec(
              "UPDATE hindsight_models SET status=?,operation_id=NULL,error=? WHERE id=?",
              "failed",
              "Hindsight mental model operation failed",
              model.id,
            );
          } else if (["completed", "succeeded"].includes(String(op.status)))
            this.options.sql.exec(
              "UPDATE hindsight_models SET status=?,operation_id=NULL,error=NULL WHERE id=?",
              "ready",
              model.id,
            );
        } catch (error) {
          if (error instanceof HindsightError && error.status === 404) {
            this.options.sql.exec("UPDATE hindsight_models SET status=?,operation_id=NULL,error=? WHERE id=?", "failed", "Hindsight mental model operation was not found", model.id);
          }
          continue;
        }
        continue;
      }
      if (model.bank_id === row.bank_id && model.status === "failed") continue;
      if (
        model.bank_id === row.bank_id &&
        model.remote_id &&
        model.status === "ready"
      )
        continue;
      this.options.sql.exec(
        "UPDATE hindsight_models SET bank_id=?,status=?,error=NULL WHERE id=?",
        row.bank_id,
        "creating",
        model.id,
      );
      try {
        const result = (await client.createMentalModel(row.bank_id, {
          id: model.id,
          name: model.name,
          query: model.query,
        })) as { mental_model_id?: string; id?: string; operation_id?: string };
        if (generation !== this.generation || this.projection(row.bot_id)?.bank_id !== row.bank_id) return;
        const remoteId = result.mental_model_id ?? result.id ?? model.id;
        this.options.sql.exec(
          "UPDATE hindsight_models SET remote_id=?,bank_id=?,operation_id=?,status=?,error=NULL WHERE id=?",
          remoteId,
          row.bank_id,
          result.operation_id ?? null,
          result.operation_id ? "pending" : "ready",
          model.id,
        );
      } catch (error) {
        // A lost acknowledgement can surface as conflict because the deterministic local ID
        // was already created remotely. Treat that as reconciled rather than duplicating it.
        if (error instanceof HindsightError && error.status === 409) {
          this.options.sql.exec(
            "UPDATE hindsight_models SET remote_id=?,bank_id=?,status=?,error=NULL WHERE id=?",
            model.id,
            row.bank_id,
            "ready",
            model.id,
          );
          continue;
        }
        this.options.sql.exec(
          "UPDATE hindsight_models SET bank_id=?,status=?,error=? WHERE id=?",
          row.bank_id,
          "failed",
          plainError(error),
          model.id,
        );
      }
    }
  }
  async modelAction(botId: string, id: string, action: "delete" | "refresh") {
    const row = this.ready(botId),
      model = this.options.sql
        .exec(
          "SELECT * FROM hindsight_models WHERE bot_id=? AND (id=? OR remote_id=?)",
          botId,
          id,
          id,
        )
        .toArray()[0];
    if (!model || model.bank_id !== row.bank_id)
      throw new MemoryError(404, "Mental model not found");
    if (!model.remote_id)
      throw new MemoryError(409, "Mental model is still being created.");
    const client = this.options.client(this.settings());
    if (action === "delete") {
      await client.deleteMentalModel(row.bank_id, model.remote_id);
      this.options.sql.exec(
        "DELETE FROM hindsight_models WHERE id=?",
        model.id,
      );
      return { deleted: true };
    }
    const result = (await client.refreshMentalModel(
      row.bank_id,
      model.remote_id,
    )) as { operation_id?: string };
    this.options.sql.exec(
      "UPDATE hindsight_models SET operation_id=?,status=?,error=NULL WHERE id=?",
      result.operation_id ?? null,
      result.operation_id ? "pending" : "ready",
      model.id,
    );
    this.options.schedule();
    if (this.ready(botId).bank_id !== row.bank_id)
      throw new MemoryError(409, "Memory access changed");
    return result;
  }
  capture(run: {
    id: string;
    bot_id: string;
    thread_id: string;
    prompt: string;
    result: string;
    updated_at: string;
  }) {
    const config = this.settings();
    if (
      !config.enabled ||
      !config.autoCapture ||
      run.updated_at < config.since ||
      this.options.sql
        .exec("SELECT run_id FROM hindsight_captures WHERE run_id=?", run.id)
        .toArray().length
    )
      return;
    const content = redactHindsightText(
      `User: ${String(run.prompt).slice(0, 6000)}\nBot: ${String(run.result).slice(0, 9000)}`,
    );
    if (!run.result?.trim()) return;
    const memory = this.options.registry.create(
      {
        botId: run.bot_id,
        title: "Conversation learning",
        content,
        kind: "note",
        tags: ["conversation"],
        visibility: "private",
      },
      { botId: run.bot_id, threadId: run.thread_id, runId: run.id },
    );
    this.options.sql.exec(
      "INSERT OR IGNORE INTO hindsight_captures VALUES (?,?)",
      run.id,
      memory.id,
    );
    this.options.schedule();
  }
}
