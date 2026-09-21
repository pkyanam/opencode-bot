import { Buffer } from "node:buffer";
import { UpdateController } from "./update-controller";
import packageInfo from "../../../package.json";
import { ComputerStartup } from "./computer-startup";
import { telegramActivity } from "./telegram-activity";
import { NodeRegistry } from "../../../packages/nodes/src/index";
import {
  TelegramService,
  DurableObjectTelegramStore,
  webhookJson,
} from "../../../packages/telegram/src/index";
import {
  assertTransition,
  canTransition,
  id,
  isoNow,
  json,
  parseJson,
  type Decision,
  type RunStatus,
} from "../../../packages/domain/src/index";
import { CloudflareComputerProvider } from "../../../packages/computer-cloudflare/src/index";
import { advanceDue } from "../../../packages/domain/src/routines";
import {
  EXTENSION_REPOSITORY_SCHEMA,
  ExtensionRepositoryError,
  extensionRepositoryView,
  fetchRepositoryFile,
  fetchRepositoryBytes,
  listRepositoryTree,
  normalizeTreeFiles,
  parseGitHubRepositoryUrl,
  parseSkillMarkdown,
  repositoryId,
  safeRelativePath,
  skillDirectoryFromPath,
} from "./extension-repositories";
import {
  ComputerManager,
  DurableObjectCheckpointStore,
} from "../../../packages/coordinator-cloudflare/src/index";
import { PairingError, PairingService } from "./pairing";
import { createMcpHandler } from "./mcp";
// Re-export the Cloudflare Sandbox Durable Object class for the `SANDBOX`
// container binding declared in wrangler.jsonc.
export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  WORKSPACE: DurableObjectNamespace;
  SANDBOX?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  APP_TOKEN?: string;
  APP_ACCOUNT_ID?: string;
  APP_WORKER_NAME?: string;
  RUNNER_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  XAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  ARTIFACTS?: R2Bucket;
};

const MAX_CHAT_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_ID = /^att_[0-9a-f-]{20,80}$/;

const textEncoder = new TextEncoder();

function safeEqual(a: string, b: string): boolean {
  const aa = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const n = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < n; i++)
    diff |= (aa[i % (aa.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  return diff === 0;
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

function response(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

async function body<T extends Record<string, unknown>>(
  request: Request,
): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1_000_000) throw new HttpError(413, "request body too large");
  const raw = await request.text();
  if (textEncoder.encode(raw).byteLength > 1_000_000)
    throw new HttpError(413, "request body too large");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("object required");
    return value as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Workspace {
  private initialized = false;
  private maintenance = false;
  private readonly startup = new ComputerStartup();
  private updateController?: UpdateController;
  private computerProvider?: CloudflareComputerProvider;
  private computerCoordinator?: ComputerManager;
  private pairingService?: PairingService;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.storage.setAlarm(Date.now() + 1000);
  }

  private nodeRegistry?: NodeRegistry;
  private telegramService?: TelegramService;
  private nodes() {
    return (this.nodeRegistry ??= new NodeRegistry(this.state.storage.sql));
  }
  private pairing() {
    return (this.pairingService ??= new PairingService(this.state.storage.sql));
  }
  private assertAssignableNode(nodeId: string): void {
    const node = this.nodes().get(nodeId);
    if (!node) throw new HttpError(404, "node not found");
    if (node.revokedAt) throw new HttpError(409, "node has been revoked");
  }
  private telegram() {
    return (this.telegramService ??= new TelegramService({
      store: new DurableObjectTelegramStore(this.state.storage.sql),
      commandsForBot: async () => [
        { command: "compact", description: "Compact this conversation" },
        { command: "commands", description: "Show available commands" },
      ],
      onCommand: async (message) => this.telegramCommand(message),
      onMessage: async (message) => {
        if (message.ownerUserId !== "owner")
          throw new HttpError(403, "Unrecognized Telegram owner");
        const thread = this.one<any>(
          "SELECT * FROM threads WHERE id=? AND bot_id=?",
          message.threadId,
          message.botId,
        );
        if (!thread)
          throw new HttpError(404, "Linked conversation no longer exists");
        const run = this.createRun({
          threadId: thread.id,
          prompt: message.text,
          attachments: message.attachments?.length
            ? await Promise.all(message.attachments.map((attachment) => this.uploadAttachment({ bytes: attachment.bytes, name: attachment.name, mimeType: attachment.mimeType })))
            : undefined,
          idempotencyKey: message.idempotencyKey,
        });
        return { runId: run.id };
      },
    }));
  }
  private async telegramCommand(message: any): Promise<any> {
    if (message.ownerUserId !== "owner")
      throw new HttpError(403, "Unrecognized Telegram owner");
    const thread = this.one<any>(
      "SELECT * FROM threads WHERE id=? AND bot_id=?",
      message.threadId,
      message.botId,
    );
    if (!thread)
      throw new HttpError(404, "Linked conversation no longer exists");
    const bot = this.one<any>("SELECT * FROM bots WHERE id=?", message.botId);
    const name = message.commandName;
    if (name === "new") {
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS telegram_command_receipts (id TEXT PRIMARY KEY,result TEXT NOT NULL)",
      );
      const prior = this.one<any>(
        "SELECT result FROM telegram_command_receipts WHERE id=?",
        message.idempotencyKey,
      );
      if (prior) return JSON.parse(prior.result);
      const next = this.createThread({
        botId: bot.id,
        title: message.commandText?.trim() || "Telegram",
      });
      const result = {
        threadId: next.id,
        text: `New conversation with ${bot.name}. Model: ${bot.model}. Your bot settings and assigned skills carry over.`,
      };
      this.state.storage.sql.exec(
        "INSERT INTO telegram_command_receipts VALUES (?,?)",
        message.idempotencyKey,
        JSON.stringify(result),
      );
      return result;
    }
    if (name === "status") {
      const latest = this.one<any>(
        "SELECT status FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1",
        thread.id,
      );
      return {
        text: `${bot.name} · ${thread.title}\nModel: ${bot.model}\n${latest ? `Latest request: ${latest.status}` : "Ready for your first message."}`,
      };
    }
    if (name === "stop") {
      const active = this.one<any>(
        "SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','provisioning','running','waiting_approval','waiting_dependency','cancelling') ORDER BY created_at DESC LIMIT 1",
        thread.id,
      );
      if (!active)
        return { text: "There is no active request in this conversation." };
      await this.runAction(active.id, { action: "cancel" });
      return { text: "Stop requested." };
    }
    const help =
      "/new [title] — start a conversation with the same bot settings\n/status — current conversation and request\n/stop — stop this conversation’s request\n/compact — compact the native conversation\n/commands — list available commands\n/help — show this help";
    if (name === "help") return { text: help };
    if (name === "compact") {
      if (!thread.runner_session_id)
        return {
          text: "Send a message first to start the native conversation.",
        };
      const run = this.createRun({
        threadId: thread.id,
        prompt: "/compact",
        sessionAction: "compact",
        sessionActionInput: {},
        idempotencyKey: message.idempotencyKey,
      });
      return { runId: run.id, text: "Compacting this conversation…" };
    }
    if (thread.node_id)
      return {
        text: `${help}\n\nUse the app for additional commands on your owned computer.`,
      };
    const catalogResponse = await this.catalog();
    if (!catalogResponse.ok)
      return {
        text: "OpenCode’s command catalog is unavailable. Try again when the computer is ready.",
      };
    const catalog: any = await catalogResponse.json();
    const commands = Array.isArray(catalog.commands) ? catalog.commands : [];
    if (name === "commands")
      return {
        text:
          help +
          (commands.length
            ? "\n\nOpenCode commands:\n" +
              commands
                .map(
                  (c: any) =>
                    `/${c.name} — ${c.description ?? "OpenCode command"}`,
                )
                .join("\n")
            : ""),
      };
    if (!commands.some((c: any) => c.name === name))
      return {
        text: "Unknown command. Send /commands to see what is available.",
      };
    const run = this.createRun({
      threadId: thread.id,
      prompt: `/${name} ${message.commandText ?? ""}`,
      commandName: name,
      commandText: message.commandText ?? "",
      idempotencyKey: message.idempotencyKey,
    });
    return { runId: run.id };
  }
  private async telegramSettings(
    botId: string,
    action: string | undefined,
    request: Request,
  ) {
    if (!this.one("SELECT id FROM bots WHERE id=?", botId))
      throw new HttpError(404, "Bot not found");
    const service = this.telegram();
    if (request.method === "GET" && !action) {
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS telegram_channel_health (bot_id TEXT PRIMARY KEY,checked_at TEXT,error TEXT)",
      );
      return response({
        config: await service.getBotConfig(botId),
        bindings: await service.listPairings(botId),
        health:
          this.one<any>(
            "SELECT checked_at AS checkedAt,error FROM telegram_channel_health WHERE bot_id=?",
            botId,
          ) ?? null,
      });
    }
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    const input = await body<any>(request);
    if (action === "configure") {
      const result = await service.configureBot({
        botId,
        token: String(input.token ?? ""),
        transport: input.transport === "polling" ? "polling" : "webhook",
        webhookUrl: input.webhookUrl ? String(input.webhookUrl) : undefined,
      });
      this.schedule();
      return response(result);
    }
    if (action === "commands") {
      await service.refreshCommands(botId);
      return response({ updated: true });
    }
    if (action === "pairing") {
      const thread =
        this.one<any>(
          "SELECT * FROM threads WHERE bot_id=? AND title='Telegram' ORDER BY created_at DESC LIMIT 1",
          botId,
        ) ?? this.createThread({ botId, title: "Telegram" });
      return response(
        await service.createPairingLink({
          botId,
          ownerUserId: "owner",
          threadId: thread.id,
        }),
      );
    }
    if (action === "unlink")
      return response({
        removed: await service.revokePairing({
          botId,
          chatId: String(input.chatId ?? ""),
          telegramUserId: String(input.telegramUserId ?? ""),
        }),
      });
    throw new HttpError(404, "Not found");
  }
  private async pollTelegram() {
    const service = this.telegram();
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS telegram_channel_health (bot_id TEXT PRIMARY KEY,checked_at TEXT,error TEXT)",
    );
    for (const row of this.rows<any>(
      "SELECT bot_id FROM telegram_bot_configs WHERE transport='polling'",
    )) {
      const outcome = await service.pollOnce(row.bot_id, 0);
      this.state.storage.sql.exec(
        "INSERT INTO telegram_channel_health (bot_id,checked_at,error) VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error",
        row.bot_id,
        isoNow(),
        outcome.error ?? null,
      );
    }
  }
  private async deliverTelegramProgress() {
    // Only chats that explicitly started a run receive activity updates.
    const runs = this.rows<any>(`SELECT r.* FROM runs r JOIN telegram_run_deliveries d ON d.run_id=r.id
      WHERE d.status='pending' AND (r.status IN ('queued','provisioning','running','waiting_approval','cancelling') OR EXISTS (SELECT 1 FROM delegation_continuations c WHERE c.source_run_id=r.id AND c.status='pending')) ORDER BY r.created_at LIMIT 8`);
    for (const run of runs) {
      try {
        let messages: any[] = [];
        const thread = this.one<any>('SELECT node_id,runner_session_id FROM threads WHERE id=?', run.thread_id);
        if(thread?.runner_session_id && !thread.node_id && !this.maintenance) {
          const result = await this.nativeMessages(run.thread_id);
          if(result.ok) messages = ((await result.json()) as any).messages ?? [];
        }
        let text = telegramActivity(run,messages);
        const pending = this.one<any>("SELECT source_run_id FROM delegation_continuations WHERE source_run_id=? AND status='pending'",run.id);
        if(pending) {
          const peers = this.rows<any>('SELECT b.name,r.* FROM delegations d JOIN bots b ON b.id=d.target_bot_id JOIN runs r ON r.id=d.target_run_id WHERE d.source_run_id=? ORDER BY d.created_at LIMIT 8',run.id);
          text = 'Working with other bots\n\n' + peers.map(peer=>`${peer.name}: ${peer.status==='succeeded'?'finished':peer.status==='queued'?'waiting for the computer':peer.status.replaceAll('_',' ')}`).join('\n');
          const peer = peers.find(peer=>peer.status==='running');
          if(peer) {
            const peerThread = this.one<any>('SELECT node_id FROM threads WHERE id=?',peer.thread_id);
            if(!peerThread?.node_id) {
              const result = await this.nativeMessages(peer.thread_id);
              if(result.ok) text += '\n\n' + telegramActivity(peer,((await result.json()) as any).messages??[]);
            }
          }
        }
        await this.telegram().deliverRunProgress({runId:run.id,text});
      } catch { /* Progress failure must never prevent a final reply or run reconciliation. */ }
    }
  }
  private async deliverTelegramResults() {
    // Delivery records exist only for runs explicitly started through Telegram.
    for (const run of this.rows<any>(
      "SELECT * FROM runs WHERE status IN ('succeeded','failed','cancelled','needs_review') ORDER BY updated_at DESC LIMIT 100",
    )) {
      try {
        if(this.one<any>("SELECT source_run_id FROM delegation_continuations WHERE source_run_id=? AND status IN ('pending','created')",run.id)) continue;
        await this.telegram().deliverRunCompletion({
          runId: run.id,
          status: run.status,
          output: run.result || undefined,
          error: run.error || undefined,
        });
      } catch {
        /* The channel adapter persists delivery state; a later sweep retries safe failures. */
      }
    }
  }

  private init(): void {
    if (this.initialized) return;
    const sql = this.state.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    try {
      sql.exec("ALTER TABLE bots ADD COLUMN agent TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE bots ADD COLUMN node_id TEXT");
    } catch {
      /* already exists */
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    try {
      sql.exec("ALTER TABLE threads ADD COLUMN runner_session_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE threads ADD COLUMN node_id TEXT");
    } catch {
      /* already exists */
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
    );
    try { sql.exec("ALTER TABLE messages ADD COLUMN attachments TEXT"); } catch { /* already exists */ }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, error TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatch_attempts INTEGER NOT NULL DEFAULT 0, runner_session_id TEXT, runner_sequence INTEGER NOT NULL DEFAULT 0)`,
    );
    try { sql.exec("ALTER TABLE runs ADD COLUMN attachments TEXT"); } catch { /* already exists */ }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN command_name TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN session_action TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN session_action_input TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN command_text TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN runner_session_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec(
        "ALTER TABLE runs ADD COLUMN runner_sequence INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN node_job_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN node_command_job_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      sql.exec("ALTER TABLE runs ADD COLUMN bot_messaging INTEGER NOT NULL DEFAULT 1");
    } catch {
      /* already exists */
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, sequence))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS approvals (request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    try {
      sql.exec("ALTER TABLE approvals ADD COLUMN payload TEXT");
    } catch {
      /* already exists */
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS memory_items (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS bot_skills (bot_id TEXT NOT NULL, skill_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(bot_id, skill_id), FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE, FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE)`,
    );
    sql.exec(EXTENSION_REPOSITORY_SCHEMA);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, interval_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, source_bot_id TEXT NOT NULL, source_thread_id TEXT NOT NULL, target_bot_id TEXT NOT NULL, target_thread_id TEXT NOT NULL, target_run_id TEXT NOT NULL, prompt TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    try { sql.exec("ALTER TABLE delegations ADD COLUMN source_run_id TEXT"); } catch { /* already exists */ }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS delegation_requests (run_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT, delegation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, request_id))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS delegation_continuations (source_run_id TEXT PRIMARY KEY, status TEXT NOT NULL, continuation_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS message_inputs (idempotency_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, native_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    try { sql.exec("ALTER TABLE message_inputs ADD COLUMN attachments TEXT"); } catch { /* already exists */ }
    sql.exec(`CREATE TABLE IF NOT EXISTS chat_attachments (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS bot_creation_requests (run_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, bot_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, request_id))`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS bot_creation_continuations (source_run_id TEXT PRIMARY KEY, continuation_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, sequence)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS runs_status_created ON runs(status, created_at)`,
    );
    this.initialized = true;
  }

  private rows<T = Record<string, unknown>>(
    query: string,
    ...args: unknown[]
  ): T[] {
    return this.state.storage.sql.exec(query, ...args).toArray() as T[];
  }
  private one<T = Record<string, unknown>>(
    query: string,
    ...args: unknown[]
  ): T | undefined {
    return this.rows<T>(query, ...args)[0];
  }
  private event(runId: string, type: string, payload: unknown): void {
    const next =
      this.one<{ n: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events WHERE run_id = ?",
        runId,
      )?.n ?? 1;
    this.state.storage.sql.exec(
      "INSERT INTO events (id, run_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id("evt"),
      runId,
      next,
      type,
      json(payload),
      isoNow(),
    );
  }
  private run(row: any): any {
    if (!row) return null;
    const events = this.events(row.id, 30);
    const restart = row.status === "needs_review" && events.some(event => event.type === "runner.recovery.needs_review");
    const error = row.error || (restart ? "The computer restarted before completion could be confirmed. Review its work before retrying." : undefined);
    const startedAt = this.one<{ created_at: string }>("SELECT created_at FROM events WHERE run_id=? AND type IN ('run.dispatching','node.dispatching') ORDER BY sequence LIMIT 1", row.id)?.created_at;
    let queue;
    if (row.status === "queued") {
      const blockedBy = this.one<any>("SELECT r.id,r.status,b.name AS botName FROM runs r JOIN threads t ON t.id=r.thread_id JOIN bots b ON b.id=t.bot_id WHERE r.id<>? AND r.status IN ('provisioning','running','waiting_approval','waiting_human','recovering','cancelling') ORDER BY r.created_at,r.rowid LIMIT 1", row.id);
      const ahead = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs r WHERE r.status='queued' AND (r.created_at<? OR (r.created_at=? AND r.rowid<(SELECT rowid FROM runs WHERE id=?)))", row.created_at, row.created_at, row.id)?.n ?? 0;
      queue = { position: ahead + 1, ...(blockedBy ? { blockedBy } : {}), reconnecting: events.some(event => event.type === "runner.reconcile_error") };
    }
    return {
      id: row.id,
      threadId: row.thread_id,
      prompt: row.prompt,
      internal: Number(row.bot_messaging ?? 1) === 0,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt,
      ...(queue ? { queue } : {}),
      ...(row.node_job_id ? { nodeJobId: row.node_job_id } : {}),
      ...(row.node_command_job_id
        ? { nodeCommandJobId: row.node_command_job_id }
        : {}),
      events,
      ...(error ? { error } : {}),
      ...(row.result ? { result: row.result } : {}),
      ...(row.attachments ? { attachments: parseJson(row.attachments, []) } : {}),
    };
  }
  private events(runId: string, limit?: number): any[] {
    const rows = limit === undefined
      ? this.rows<any>("SELECT * FROM events WHERE run_id = ? ORDER BY sequence", runId)
      : this.rows<any>("SELECT * FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?", runId, limit).reverse();
    return rows.map((e) => ({
      id: e.id,
      runId: e.run_id,
      sequence: e.sequence,
      type: e.type,
      payload: parseJson(e.payload, null),
      createdAt: e.created_at,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    this.init();
    const url = new URL(request.url);
    const ownerAuthorized = Boolean(this.env.APP_TOKEN && bearer(request) && safeEqual(bearer(request)!, this.env.APP_TOKEN));
    const internalAuthorized = Boolean(url.pathname.startsWith("/internal/") && this.env.RUNNER_TOKEN && bearer(request) && safeEqual(bearer(request)!, this.env.RUNNER_TOKEN));
    const client = ownerAuthorized ? null : await this.pairing().authenticate(bearer(request));
    const externallyAuthenticated = url.pathname === "/api/pairing/redeem" || url.pathname === "/api/nodes" || url.pathname.startsWith("/api/nodes/") || /^\/api\/integrations\/telegram\/webhook\/[^/]+$/.test(url.pathname);
    if (!ownerAuthorized && !internalAuthorized && !client && !externallyAuthenticated)
      return response({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (client && !clientRouteAllowed(request, url))
      return response({ error: "client credential is not authorized for this operation" }, 403);
    if (url.pathname === "/api/mcp") {
      return createMcpHandler({
        authorize: () => ownerAuthorized || Boolean(client),
        serverVersion: packageInfo.version,
        filterTools: (_request, tools) => ownerAuthorized ? tools : tools.filter(tool => CLIENT_MCP_TOOLS.has(tool.name)),
        invoke: async ({ path, method, body: input }) => {
          const headers = new Headers({ Authorization: request.headers.get("authorization") ?? "" });
          const raw = typeof input === "string";
          const multipart = input instanceof FormData;
          if (input !== undefined && !multipart) headers.set("content-type", raw ? "text/plain; charset=utf-8" : "application/json");
          // Re-enter the same routes with the caller's credential. Never elevate a paired device.
          const result = await this.fetch(new Request(new URL(path, url), {
            method, headers, ...(input === undefined ? {} : { body: raw || multipart ? input as BodyInit : JSON.stringify(input) }),
          }));
          const contentType = result.headers.get("content-type") ?? "";
          const bytes = new Uint8Array(await result.arrayBuffer());
          if (bytes.byteLength > 10 * 1024 * 1024) return { status: 413, body: { error: "Result exceeds 10 MiB; use the file download API." } };
          if (contentType.includes("application/json")) {
            try { return { status: result.status, body: JSON.parse(new TextDecoder().decode(bytes)) }; }
            catch { return { status: 502, body: { error: "Invalid JSON from workspace operation." } }; }
          }
          return { status: result.status, body: contentType.startsWith("text/")
            ? { text: new TextDecoder().decode(bytes), mimeType: contentType }
            : { contentBase64: Buffer.from(bytes).toString("base64"), mimeType: contentType || "application/octet-stream" } };
        },
      })(request);
    }
    const computerDependent = /^\/api\/(catalog|providers(?:\/.*)?|computer\/(status|preview)|terminal(?:\/.*)?|extensions\/plugins|extension-repositories\/[^/]+\/install)$/.test(url.pathname);
    try {
      if (url.pathname === "/api/pairing/redeem" && request.method === "POST")
        {
          const length = Number(request.headers.get("content-length") ?? 0);
          if (length > 8192 || textEncoder.encode(await request.clone().text()).byteLength > 8192) throw new HttpError(413, "request body too large");
          return response(await this.pairing().redeem(await body(request), request.headers.get("cf-connecting-ip") ?? "unknown"), 201);
        }
      if (url.pathname === "/api/pairing/invites" && request.method === "POST") {
        if (!ownerAuthorized) throw new HttpError(401, "owner authorization required");
        return response(await this.pairing().createInvite(await body(request)), 201);
      }
      if (url.pathname === "/api/pairing/devices" && request.method === "GET") {
        if (!ownerAuthorized) throw new HttpError(401, "owner authorization required");
        return response({ devices: this.pairing().listDevices() });
      }
      const deletePairingInvite = url.pathname.match(/^\/api\/pairing\/invites\/([^/]+)$/);
      if (deletePairingInvite && request.method === "DELETE") {
        if (!ownerAuthorized) throw new HttpError(401, "owner authorization required");
        return response(this.pairing().deleteInvite(decodeURIComponent(deletePairingInvite[1])));
      }
      const revokePairing = url.pathname.match(/^\/api\/pairing\/devices\/([^/]+)\/revoke$/);
      if (revokePairing && request.method === "POST") {
        if (!ownerAuthorized) throw new HttpError(401, "owner authorization required");
        return response(this.pairing().revokeDevice(decodeURIComponent(revokePairing[1])));
      }
      if ((url.pathname === "/api/pairing/session" || url.pathname === "/api/pairing/session/me") && request.method === "GET")
        return response(client ? { role: "client", ...client } : { role: "owner" });
      if (url.pathname === "/api/updates" || url.pathname.startsWith("/api/updates/"))
        return await this.updateRoute(request, url);
      if (typeof this.state.storage.get === "function" && await this.updates(url).active()) {
        if (url.pathname === "/api/computer/readiness") return response({ state: "starting", reason: "app_updating", retryAfterMs: 5000 });
        if (computerDependent || !["GET", "HEAD"].includes(request.method))
          return response({ error: "The app is updating. You can follow its progress in Settings → Updates.", code: "app_updating" }, 503);
      }
      if (url.pathname === "/api/computer/readiness" && ["GET", "POST"].includes(request.method))
        return response(this.computerReadiness(request.method === "POST"));
      if (computerDependent) {
        const readiness = this.computerReadiness();
        if (readiness.state !== "ready") return response({
          ...readiness,
          code: readiness.state === "starting" ? "computer_starting" : "computer_unavailable",
          error: readiness.error ?? "Your computer is starting. You can explore the app while it gets ready.",
        }, 503, { "retry-after": "3" });
      }

      if (
        url.pathname === "/api/nodes" ||
        url.pathname.startsWith("/api/nodes/")
      )
        return await this.nodes().handle(request, {
          adminAuthorized: Boolean(
            this.env.APP_TOKEN &&
            bearer(request) &&
            safeEqual(bearer(request)!, this.env.APP_TOKEN),
          ),
        });
      const webhook = url.pathname.match(
        /^\/api\/integrations\/telegram\/webhook\/([^/]+)$/,
      );
      if (webhook && request.method === "POST")
        return webhookJson(
          await this.telegram().handleWebhook(webhook[1], request),
        );
      const telegramRoute = url.pathname.match(
        /^\/api\/bots\/([^/]+)\/telegram(?:\/(configure|pairing|unlink|commands))?$/,
      );
      if (telegramRoute)
        return await this.telegramSettings(
          telegramRoute[1],
          telegramRoute[2],
          request,
        );
      if (url.pathname === "/api/state" && request.method === "GET")
        return response(this.stateView());
      if (url.pathname === "/internal/sweep" && request.method === "POST") {
        await this.alarm();
        return response({ ok: true });
      }
      if (url.pathname === "/api/computer/status" && request.method === "GET")
        return response(await this.computerStatus());
      if (
        url.pathname === "/api/computer/checkpoint" &&
        request.method === "POST"
      )
        return response(await this.computerCheckpoint());
      if (url.pathname === "/api/computer/restore" && request.method === "POST")
        return response(await this.computerRestore());
      if (
        url.pathname === "/api/providers" ||
        url.pathname.startsWith("/api/providers/")
      )
        return await this.providerProxy(request, url);
      if (url.pathname === "/api/catalog" && request.method === "GET")
        return await this.catalog();
      if (url.pathname === "/api/computer/preview" && request.method === "GET")
        return await this.preview(request);
      if (
        url.pathname === "/api/terminal" ||
        /^\/api\/terminal\/[A-Za-z0-9._:-]+(?:\/(?:output|input|resize))?$/.test(
          url.pathname,
        )
      )
        return await this.terminalProxy(request, url);
      const nativeMessages = url.pathname.match(
        /^\/api\/threads\/([^/]+)\/messages$/,
      );
      if (nativeMessages && request.method === "GET")
        return await this.nativeMessages(nativeMessages[1]);
      if (
        (url.pathname === "/api/files" ||
          url.pathname === "/api/files/content") &&
        ["GET", "POST"].includes(request.method)
      )
        return await this.fileProxy(request, url);
      if (url.pathname === "/api/uploads" && request.method === "POST")
        return response(await this.uploadRequest(request), 201);
      const uploadDownload = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (uploadDownload && request.method === "GET") {
        const item = this.one<any>("SELECT path,name,mime_type,size FROM chat_attachments WHERE id=?", uploadDownload[1]);
        if (!item) throw new HttpError(404, "attachment not found");
        const transport = await this.transport();
        const result = await transport.fetch(`/files/content?path=${encodeURIComponent(item.path)}`, { method: "GET" });
        const headers = new Headers({ "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${item.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "cache-control": "no-store" });
        return new Response(result.body, { status: result.status, headers });
      }
      if (url.pathname === "/api/bots" && request.method === "GET")
        return response(this.bots());
      if (url.pathname === "/api/bots" && request.method === "POST")
        return response(this.createBot(await body(request)), 201);
      const botEdit = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
      if (botEdit && request.method === "DELETE")
        return response(await this.deleteBot(botEdit[1]));
      if (botEdit && request.method === "PATCH")
        return response(this.updateBot(botEdit[1], await body(request)));
      if (url.pathname === "/api/skills" && request.method === "GET")
        return response(this.skills());
      if (url.pathname === "/api/skills" && request.method === "POST")
        return response(this.createSkill(await body(request)), 201);
      if (url.pathname === "/api/extensions/plugins" && ["GET","POST","DELETE"].includes(request.method)) {
        const transport = await this.transport();
        const result = await transport.fetch("/extensions/plugins", {method:request.method, headers:{"content-type":"application/json"}, ...(request.method !== "GET" ? {body:JSON.stringify(await body(request))} : {})});
        return response(await result.json(), result.status);
      }
      if (url.pathname === "/api/extension-repositories" && request.method === "GET")
        return response({ repositories: this.extensionRepositories() });
      if (url.pathname === "/api/extension-repositories" && request.method === "POST")
        return response(this.addExtensionRepository(await body(request)), 201);
      const extensionRepoRoute = url.pathname.match(/^\/api\/extension-repositories\/([^/]+)(?:\/(tree|preview|install))?$/);
      if (extensionRepoRoute) {
        const repoId = decodeURIComponent(extensionRepoRoute[1]);
        const action = extensionRepoRoute[2];
        if (!action && request.method === "DELETE") return response(this.removeExtensionRepository(repoId));
        if (action === "tree" && request.method === "GET") return response(await this.extensionTree(repoId, url.searchParams.get("path") ?? undefined));
        if (action === "preview" && request.method === "GET") return response(await this.extensionPreview(repoId, url.searchParams.get("path") ?? ""));
        if (action === "install" && request.method === "POST") return response(await this.installExtension(repoId, await body(request)), 201);
      }
      const skillEdit = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillEdit && request.method === "PATCH")
        return response(this.updateSkill(skillEdit[1], await body(request)));
      if (skillEdit && request.method === "DELETE")
        return response(this.deleteSkill(skillEdit[1]));
      const botSkills = url.pathname.match(/^\/api\/bots\/([^/]+)\/skills$/);
      if (botSkills && request.method === "GET")
        return response(this.botSkills(botSkills[1]));
      if (botSkills && request.method === "PUT")
        return response(this.assignSkills(botSkills[1], await body(request)));
      const botMemory = url.pathname.match(
        /^\/api\/bots\/([^/]+)\/memory(?:\/([^/]+))?$/,
      );
      if (botMemory) return await this.memoryRoute(request, botMemory[1]);
      if (url.pathname === "/api/threads" && request.method === "GET")
        return response(this.threads());
      if (url.pathname === "/api/threads" && request.method === "POST")
        return response(this.createThread(await body(request)), 201);
      const delegationRoute = url.pathname.match(
        /^\/api\/threads\/([^/]+)\/delegations$/,
      );
      if (delegationRoute && request.method === "GET")
        return response(this.delegations(delegationRoute[1]));
      if (delegationRoute && request.method === "POST")
        return response(
          this.createDelegation(delegationRoute[1], await body(request)),
          202,
        );
      const renameThread = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (renameThread && request.method === "DELETE")
        return response(await this.deleteThread(renameThread[1]));
      if (renameThread && request.method === "PATCH") {
        const input = await body<any>(request);
        if (
          typeof input.title !== "string" ||
          !input.title.trim() ||
          input.title.length > 160
        )
          throw new HttpError(
            400,
            "Conversation title must contain 1–160 characters",
          );
        const changed = this.state.storage.sql.exec(
          "UPDATE threads SET title=?,updated_at=? WHERE id=?",
          input.title.trim(),
          isoNow(),
          renameThread[1],
        );
        if (!changed.rowsWritten)
          throw new HttpError(404, "Conversation not found");
        return response(this.threads().find((t) => t.id === renameThread[1]));
      }
      if (url.pathname === "/api/routines" && request.method === "GET")
        return response(this.routines());
      if (url.pathname === "/api/routines" && request.method === "POST")
        return response(this.createRoutine(await body(request)), 201);
      const routine = url.pathname.match(/^\/api\/routines\/([^/]+)$/);
      if (routine && request.method === "PATCH")
        return response(this.updateRoutine(routine[1], await body(request)));
      if (routine && request.method === "DELETE")
        return response(this.deleteRoutine(routine[1]));
      const run = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (run && request.method === "GET")
        return response(this.runView(run[1]));
      if (run && request.method === "POST")
        return response(await this.runAction(run[1], await body(request)));
      const cancel = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (cancel && request.method === "POST")
        return response(await this.runAction(cancel[1], { action: "cancel" }));
      const runEvents = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (runEvents && request.method === "GET") {
        const item = this.one("SELECT id FROM runs WHERE id = ?", runEvents[1]);
        if (!item) throw new HttpError(404, "run not found");
        return response(this.events(runEvents[1]));
      }
      if (url.pathname === "/api/runs" && request.method === "POST")
        return response(this.admitMessage(await body(request)), 202);
      const action = url.pathname.match(/^\/api\/threads\/([^/]+)\/action$/);
      if (action && request.method === "POST")
        return response(
          this.createActionRun(action[1], await body(request)),
          202,
        );
      if (url.pathname === "/api/runs" && request.method === "GET")
        return response(this.runs());
      const approval = url.pathname.match(/^\/api\/runs\/([^/]+)\/approval$/);
      if (approval && request.method === "POST")
        return response(await this.approve(approval[1], await body(request)));
      throw new HttpError(404, "not found");
    } catch (error) {
      if (error instanceof PairingError) return response({ error: error.message }, error.status);
      if (computerDependent && /timeout|timed out|container.*start|not.*running|port.*available/i.test(error instanceof Error ? error.message : String(error))) {
        this.startup.invalidate();
        const readiness = this.computerReadiness();
        return response({ ...readiness, code: "computer_starting", error: "Your computer is reconnecting. Please try again shortly." }, 503, { "retry-after": "3" });
      }
      if (error instanceof HttpError)
        return response({ error: error.message }, error.status);
      if (error instanceof ExtensionRepositoryError)
        return response({ error: error.message }, error.status);
      console.error(error);
      return response({ error: "internal error" }, 500);
    }
  }

  private bots(): any[] {
    return this.rows<any>("SELECT * FROM bots ORDER BY created_at").map(
      (b) => ({
        id: b.id,
        name: b.name,
        instructions: b.instructions,
        model: b.model,
        agent: b.agent ?? "",
        nodeId: b.node_id ?? undefined,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
      }),
    );
  }
  private threads(): any[] {
    return this.rows<any>("SELECT * FROM threads ORDER BY created_at DESC").map(
      (t) => ({
        id: t.id,
        botId: t.bot_id,
        title: t.title,
        sessionId: t.runner_session_id ?? undefined,
        nodeId: t.node_id ?? undefined,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      }),
    );
  }
  private runs(): any[] {
    return this.rows<any>(
      "SELECT * FROM runs ORDER BY created_at DESC LIMIT 100",
    ).map((r) => this.run(r));
  }
  private stateView(): any {
    return { bots: this.bots(), threads: this.threads(), runs: this.runs(), pendingMessages: this.rows<any>("SELECT m.* FROM message_inputs m JOIN runs r ON r.id=m.run_id WHERE m.status IN ('pending','dispatching','needs_review') OR (m.status='accepted' AND r.status NOT IN ('succeeded','failed','cancelled','needs_review')) ORDER BY m.created_at LIMIT 100").map(m => ({id:m.idempotency_key,threadId:m.thread_id,runId:m.run_id,content:m.prompt,status:m.status,nativeId:m.native_id,createdAt:m.created_at,attachments:parseJson(m.attachments,[])})) };
  }
  private routines(): any[] {
    return this.rows<any>("SELECT * FROM routines ORDER BY created_at").map(
      (r) => ({
        id: r.id,
        botId: r.bot_id,
        threadId: r.thread_id,
        title: r.title,
        prompt: r.prompt,
        intervalMinutes: r.interval_minutes,
        enabled: Boolean(r.enabled),
        nextRunAt: r.next_run_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
    );
  }
  private createRoutine(input: any): any {
    const bot = this.one("SELECT id FROM bots WHERE id=?", input.botId);
    if (!bot) throw new HttpError(404, "bot not found");
    const interval = Number(input.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5)
      throw new HttpError(
        400,
        "intervalMinutes must be an integer of at least 5",
      );
    if (!input.title || !input.prompt)
      throw new HttpError(400, "title and prompt are required");
    const thread = this.createThread({
      botId: input.botId,
      title: `${String(input.title).slice(0, 160)} (routine)`,
    });
    const now = isoNow();
    const next = new Date(Date.now() + interval * 60_000).toISOString();
    const item = {
      id: id("routine"),
      botId: input.botId,
      threadId: thread.id,
      title: String(input.title).slice(0, 160),
      prompt: String(input.prompt),
      intervalMinutes: interval,
      enabled: input.enabled === false ? false : true,
      nextRunAt: next,
      createdAt: now,
      updatedAt: now,
    };
    this.state.storage.sql.exec(
      "INSERT INTO routines VALUES (?,?,?,?,?,?,?,?,?,?)",
      item.id,
      item.botId,
      item.threadId,
      item.title,
      item.prompt,
      item.intervalMinutes,
      item.enabled ? 1 : 0,
      next,
      now,
      now,
    );
    this.schedule();
    return item;
  }
  private updateRoutine(routineId: string, input: any): any {
    const old = this.one<any>("SELECT * FROM routines WHERE id=?", routineId);
    if (!old) throw new HttpError(404, "routine not found");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new HttpError(400, "enabled must be boolean");
    const enabled =
      input.enabled === undefined ? Boolean(old.enabled) : input.enabled;
    const now = isoNow();
    this.state.storage.sql.exec(
      "UPDATE routines SET enabled=?,updated_at=? WHERE id=?",
      enabled ? 1 : 0,
      now,
      routineId,
    );
    this.schedule();
    return this.routines().find((r) => r.id === routineId);
  }
  private deleteRoutine(routineId: string): any {
    const result = this.state.storage.sql.exec(
      "DELETE FROM routines WHERE id=?",
      routineId,
    );
    if (!result.rowsWritten) throw new HttpError(404, "routine not found");
    return { deleted: true, id: routineId };
  }
  private createBot(input: any): any {
    if (typeof input.name !== "string" || !input.name.trim())
      throw new HttpError(400, "name is required");
    if (input.name.trim().length > 160)
      throw new HttpError(400, "name must contain 1–160 characters");
    if (input.instructions !== undefined && String(input.instructions).length > 20000)
      throw new HttpError(400, "instructions must contain 0–20000 characters");
    if (input.model !== undefined && String(input.model).length > 320)
      throw new HttpError(400, "model must contain 0–320 characters");
    if (input.agent !== undefined && String(input.agent).length > 160)
      throw new HttpError(400, "agent must contain 0–160 characters");
    const nodeId =
      input.nodeId === undefined || input.nodeId === null || input.nodeId === ""
        ? null
        : String(input.nodeId);
    if (nodeId) this.assertAssignableNode(nodeId);
    const now = isoNow();
    const item = {
      id: id("bot"),
      name: input.name.trim().slice(0, 160),
      instructions: String(input.instructions ?? ""),
      model: String(input.model ?? ""),
      agent: input.agent ? String(input.agent) : "",
      nodeId: nodeId ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.storage.sql.exec(
      "INSERT INTO bots (id,name,instructions,model,agent,node_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      item.id,
      item.name,
      item.instructions,
      item.model,
      item.agent,
      nodeId,
      now,
      now,
    );
    return item;
  }
  private updateBot(botId: string, input: any): any {
    const current = this.one<any>("SELECT * FROM bots WHERE id=?", botId);
    if (!current) throw new HttpError(404, "bot not found");
    const name =
      input.name === undefined
        ? current.name
        : String(input.name).trim().slice(0, 160);
    const instructions =
      input.instructions === undefined
        ? current.instructions
        : String(input.instructions);
    const model =
      input.model === undefined ? current.model : String(input.model);
    const agent =
      input.agent === undefined ? (current.agent ?? "") : String(input.agent);
    const nodeId =
      input.nodeId === undefined
        ? (current.node_id ?? null)
        : input.nodeId === null || input.nodeId === ""
          ? null
          : String(input.nodeId);
    if (nodeId) this.assertAssignableNode(nodeId);
    if (!name) throw new HttpError(400, "name is required");
    const now = isoNow();
    this.state.storage.sql.exec(
      "UPDATE bots SET name=?,instructions=?,model=?,agent=?,node_id=?,updated_at=? WHERE id=?",
      name,
      instructions,
      model,
      agent,
      nodeId,
      now,
      botId,
    );
    return {
      id: botId,
      name,
      instructions,
      model,
      agent,
      nodeId: nodeId ?? undefined,
      createdAt: current.created_at,
      updatedAt: now,
    };
  }

  /** Delete control-plane data and, for local conversations, their native session. */
  private deleteRows(table: string, where: string, ...args: unknown[]): number {
    if (!this.one<{ n: number }>(
      "SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name=?",
      table,
    )) return 0;
    return Number(this.state.storage.sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...args).rowsWritten ?? 0);
  }

  private atomic<T>(fn: () => T): T {
    return this.state.storage.transactionSync(fn);
  }

  private deleteRunData(runIds: string[]): Record<string, number> {
    if (!runIds.length) return {};
    const marks = runIds.map(() => "?").join(",");
    const counts: Record<string, number> = {};
    // Rows referencing runs must be removed before the run receipts. These
    // tables predate foreign-key enforcement, so do this explicitly.
    for (const table of ["delegation_requests", "approvals", "events", "message_inputs"]) {
      const column = "run_id";
      counts[table] = this.deleteRows(table, `${column} IN (${marks})`, ...runIds);
    }
    counts.delegationContinuations = this.deleteRows("delegation_continuations", `(source_run_id IN (${marks}) OR continuation_run_id IN (${marks}))`, ...runIds, ...runIds);
    counts.telegramRunDeliveries = this.deleteRows("telegram_run_deliveries", `run_id IN (${marks})`, ...runIds);
    counts.telegramRunActivities = this.deleteRows("telegram_run_activities", `run_id IN (${marks})`, ...runIds);
    counts.runs = this.deleteRows("runs", `id IN (${marks})`, ...runIds);
    return counts;
  }

  private activeDeletionBlock(threadIds: string[]): { activeRuns: number; pendingHandoffs: number } {
    if (!threadIds.length) return { activeRuns: 0, pendingHandoffs: 0 };
    const marks = threadIds.map(() => "?").join(",");
    const activeRuns = Number(this.one<any>(
      `SELECT COUNT(*) AS n FROM runs WHERE thread_id IN (${marks}) AND status IN ('queued','provisioning','running','waiting_approval','waiting_dependency','cancelling')`,
      ...threadIds,
    )?.n ?? 0);
    const pendingHandoffs = Number(this.one<any>(
      `SELECT COUNT(*) AS n FROM (
        SELECT r.id FROM runs r WHERE r.thread_id IN (${marks}) AND EXISTS (SELECT 1 FROM delegation_continuations c LEFT JOIN runs cr ON cr.id=c.continuation_run_id WHERE c.source_run_id=r.id AND (c.status='pending' OR (c.status='created' AND cr.status IN ('queued','provisioning','running','waiting_approval','waiting_dependency','cancelling'))))
        UNION
        SELECT r.id FROM runs r WHERE r.thread_id IN (${marks}) AND EXISTS (SELECT 1 FROM delegation_requests q WHERE q.run_id=r.id AND q.status='pending')
        UNION
        SELECT d.id FROM delegations d WHERE (d.source_thread_id IN (${marks}) OR d.target_thread_id IN (${marks})) AND (EXISTS (SELECT 1 FROM delegation_continuations c LEFT JOIN runs cr ON cr.id=c.continuation_run_id WHERE c.source_run_id=d.source_run_id AND (c.status='pending' OR (c.status='created' AND cr.status IN ('queued','provisioning','running','waiting_approval','waiting_dependency','cancelling')))) OR EXISTS (SELECT 1 FROM delegation_requests q WHERE q.delegation_id=d.id AND q.status='pending'))
      )`,
      ...threadIds, ...threadIds, ...threadIds, ...threadIds,
    )?.n ?? 0);
    const pendingInputs = Number(this.one<any>(`SELECT COUNT(*) AS n FROM message_inputs WHERE thread_id IN (${marks}) AND status IN ('pending','dispatching')`, ...threadIds)?.n ?? 0);
    return { activeRuns: activeRuns + pendingInputs, pendingHandoffs };
  }

  private async removeNativeSessions(threadIds: string[]): Promise<string[]> {
    if (!threadIds.length) return [];
    const marks = threadIds.map(() => "?").join(",");
    if (this.one<any>(`SELECT 1 AS found FROM threads WHERE id IN (${marks}) AND node_id IS NOT NULL LIMIT 1`, ...threadIds))
      throw new HttpError(409, "owned-node conversations cannot be deleted yet");
    const rows = this.rows<any>(`SELECT runner_session_id AS session_id FROM threads WHERE id IN (${marks}) AND node_id IS NULL AND runner_session_id IS NOT NULL UNION SELECT r.runner_session_id AS session_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.thread_id IN (${marks}) AND t.node_id IS NULL AND r.runner_session_id IS NOT NULL`, ...threadIds, ...threadIds);
    const candidates = [...new Set(rows.map((r) => String(r.session_id)).filter(Boolean))];
    if (!candidates.length) return [];
    const sessionMarks = candidates.map(() => "?").join(",");
    const surviving = this.one<any>(`SELECT 1 AS found FROM threads WHERE runner_session_id IN (${sessionMarks}) AND id NOT IN (${marks}) UNION SELECT 1 FROM runs WHERE runner_session_id IN (${sessionMarks}) AND thread_id NOT IN (${marks}) LIMIT 1`, ...candidates, ...threadIds, ...candidates, ...threadIds);
    if (surviving) throw new HttpError(409, "native conversation is shared with another conversation");
    if (this.maintenance) throw new HttpError(409, "computer maintenance is in progress");
    this.maintenance = true;
    try {
      const transport = await this.transport();
      for (const sessionId of candidates) {
        const result = await transport.fetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        if (result.status === 404) continue;
        if (!result.ok) throw new HttpError(result.status === 409 ? 409 : 502, "native conversation could not be deleted");
      }
      return candidates;
    } finally {
      this.maintenance = false;
    }
  }

  private deleteThreadRecords(threadId: string): any {
    const thread = this.one<any>("SELECT id,bot_id FROM threads WHERE id=?", threadId);
    if (!thread) throw new HttpError(404, "conversation not found");
    const blocked = this.activeDeletionBlock([threadId]);
    if (blocked.activeRuns || blocked.pendingHandoffs)
      throw new HttpError(409, "conversation has active runs or pending handoffs");
    const runIds = this.rows<any>("SELECT id,node_job_id,node_command_job_id FROM runs WHERE thread_id=?", threadId);
    const counts: Record<string, number> = {};
    counts.delegations = this.deleteRows("delegations", "source_thread_id=? OR target_thread_id=?", threadId, threadId);
    counts.routines = this.deleteRows("routines", "thread_id=?", threadId);
    counts.telegramPairingChallenges = this.deleteRows("telegram_pairing_challenges", "thread_id=?", threadId);
    // Preserve the paired account; its next message starts a new conversation.
    if (this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_chat_bindings'"))
      counts.telegramChatBindingsReset = this.state.storage.sql.exec("UPDATE telegram_chat_bindings SET thread_id=NULL WHERE thread_id=?", threadId).rowsWritten;
    counts.messages = this.deleteRows("messages", "thread_id=?", threadId);
    if (runIds.length) Object.assign(counts, this.deleteRunData(runIds.map((r) => r.id)));
    const jobIds = runIds.flatMap((r) => [r.node_job_id, r.node_command_job_id]).filter(Boolean) as string[];
    if (jobIds.length)
      counts.nodeJobs = this.deleteRows("node_jobs", `id IN (${jobIds.map(() => "?").join(",")})`, ...jobIds);
    counts.threads = this.deleteRows("threads", "id=?", threadId);
    return { deleted: true, id: threadId, counts };
  }

  private async deleteThread(threadId: string): Promise<any> {
    const thread = this.one<any>("SELECT id FROM threads WHERE id=?", threadId);
    if (!thread) throw new HttpError(404, "conversation not found");
    const blocked = this.activeDeletionBlock([threadId]);
    if (blocked.activeRuns || blocked.pendingHandoffs)
      throw new HttpError(409, "conversation has active runs or pending handoffs");
    const nativeSessionsDeleted = (await this.removeNativeSessions([threadId])).length;
    return { ...this.atomic(() => this.deleteThreadRecords(threadId)), nativeSessionsDeleted };
  }

  private deleteBotRecords(botId: string): any {
    if (!this.one("SELECT id FROM bots WHERE id=?", botId))
      throw new HttpError(404, "bot not found");
    const threadRows = this.rows<any>("SELECT id FROM threads WHERE bot_id=?", botId);
    const threadIds = threadRows.map((r) => r.id as string);
    const blocked = this.activeDeletionBlock(threadIds);
    if (blocked.activeRuns || blocked.pendingHandoffs)
      throw new HttpError(409, "bot has active runs or pending handoffs");
    const counts: Record<string, number> = {};
    const runRows = threadIds.length
      ? this.rows<any>(`SELECT id,node_job_id,node_command_job_id FROM runs WHERE thread_id IN (${threadIds.map(() => "?").join(",")})`, ...threadIds)
      : [];
    const runIds = runRows.map((r) => r.id as string);
    counts.delegations = this.deleteRows("delegations", "source_bot_id=? OR target_bot_id=?", botId, botId);
    counts.routines = this.deleteRows("routines", "bot_id=?", botId);
    counts.memoryItems = this.deleteRows("memory_items", "bot_id=?", botId);
    counts.botSkills = this.deleteRows("bot_skills", "bot_id=?", botId);
    if (threadIds.length) {
      counts.messages = this.deleteRows("messages", `thread_id IN (${threadIds.map(() => "?").join(",")})`, ...threadIds);
    }
    if (runIds.length) Object.assign(counts, this.deleteRunData(runIds));
    const jobIds = runRows.flatMap((r) => [r.node_job_id, r.node_command_job_id]).filter(Boolean) as string[];
    if (jobIds.length) counts.nodeJobs = this.deleteRows("node_jobs", `id IN (${jobIds.map(() => "?").join(",")})`, ...jobIds);
    if (threadIds.length) counts.threads = this.deleteRows("threads", `id IN (${threadIds.map(() => "?").join(",")})`, ...threadIds);
    // Telegram state is bot-scoped. Processed update receipts and polling
    // offsets are safe to remove; shared native credentials and files are not.
    for (const [key, table] of Object.entries({ telegramBotConfigs: "telegram_bot_configs", telegramPairingChallenges: "telegram_pairing_challenges", telegramChatBindings: "telegram_chat_bindings", telegramProcessedUpdates: "telegram_processed_updates", telegramPollOffsets: "telegram_poll_offsets", telegramChannelHealth: "telegram_channel_health", telegramRunDeliveries: "telegram_run_deliveries", telegramRunActivities: "telegram_run_activities" }))
      counts[key] = this.deleteRows(table, "bot_id=?", botId);
    counts.bots = this.deleteRows("bots", "id=?", botId);
    return { deleted: true, id: botId, counts };
  }

  private async deleteBot(botId: string): Promise<any> {
    if (!this.one("SELECT id FROM bots WHERE id=?", botId))
      throw new HttpError(404, "bot not found");
    const threadIds = this.rows<any>("SELECT id FROM threads WHERE bot_id=?", botId).map((r) => r.id as string);
    const blocked = this.activeDeletionBlock(threadIds);
    if (blocked.activeRuns || blocked.pendingHandoffs)
      throw new HttpError(409, "bot has active runs or pending handoffs");
    const nativeSessionsDeleted = (await this.removeNativeSessions(threadIds)).length;
    return { ...this.atomic(() => this.deleteBotRecords(botId)), nativeSessionsDeleted };
  }
  private extensionRepositories(): any[] {
    return this.rows<any>("SELECT * FROM extension_repositories ORDER BY created_at DESC").map(extensionRepositoryView);
  }
  private addExtensionRepository(input: any): any {
    const repo = parseGitHubRepositoryUrl(String(input?.url ?? ""));
    const repoId = `extrepo_${repositoryId(repo).replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const now = isoNow();
    this.state.storage.sql.exec("INSERT INTO extension_repositories (id,owner,name,ref,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET updated_at=excluded.updated_at", repoId, repo.owner, repo.name, repo.ref, repo.url, now, now);
    return extensionRepositoryView(this.one<any>("SELECT * FROM extension_repositories WHERE url=?", repo.url));
  }
  private removeExtensionRepository(repoId: string): any {
    const result = this.state.storage.sql.exec("DELETE FROM extension_repositories WHERE id=?", repoId);
    if (!result.rowsWritten) throw new HttpError(404, "extension repository not found");
    return { deleted: true, id: repoId };
  }
  private extensionRepo(repoId: string): any {
    const row = this.one<any>("SELECT * FROM extension_repositories WHERE id=?", repoId);
    if (!row) throw new HttpError(404, "extension repository not found");
    return row;
  }
  private async extensionTree(repoId: string, pathValue?: string): Promise<any> {
    const row = this.extensionRepo(repoId), repo = parseGitHubRepositoryUrl(row.url), tree = await listRepositoryTree(repo);
    const prefix = pathValue ? safeRelativePath(pathValue).replace(/\/$/, "") : "";
    return { repository: extensionRepositoryView(row), path: prefix, entries: tree.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)) };
  }
  private async extensionPreview(repoId: string, pathValue: string): Promise<any> {
    const row = this.extensionRepo(repoId), repo = parseGitHubRepositoryUrl(row.url), skillDirectory = skillDirectoryFromPath(pathValue), tree = await listRepositoryTree(repo), files = normalizeTreeFiles(tree, skillDirectory), content = await fetchRepositoryFile(repo, safeRelativePath(pathValue));
    const metadata = parseSkillMarkdown(content, skillDirectory.split("/").pop() || undefined);
    return { repository: extensionRepositoryView(row), path: safeRelativePath(pathValue), metadata, files: files.map((file) => ({ path: file, size: tree.find((entry) => entry.path === file)?.size ?? null })), content };
  }
  private async installExtension(repoId: string, input: any): Promise<any> {
    const row = this.extensionRepo(repoId), repo = parseGitHubRepositoryUrl(row.url), requested = String(input?.skillPath ?? ""), directory = skillDirectoryFromPath(requested), tree = await listRepositoryTree(repo), files = normalizeTreeFiles(tree, directory), contents = [];
    let totalBytes = 0;
    for (let offset = 0; offset < files.length; offset += 4) {
      const batch = await Promise.all(files.slice(offset, offset + 4).map(async file => {
        const bytes = await fetchRepositoryBytes(repo, file);
        totalBytes += bytes.byteLength;
        if (totalBytes > 10_000_000) throw new HttpError(413, "skill download is too large");
        return {path:file.slice(directory ? directory.length + 1 : 0),contentBase64:Buffer.from(bytes).toString("base64")};
      }));
      contents.push(...batch);
    }
    const metadata = parseSkillMarkdown(Buffer.from(contents.find(file => file.path === "SKILL.md")?.contentBase64 ?? "", "base64").toString("utf8"), directory.split("/").pop() || undefined);
    const transport = await this.transport();
    const result = await transport.fetch("/extensions/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: contents, skillName: metadata.name }) });
    if (!result.ok) throw new HttpError(result.status, (await result.json<any>()).error ?? "skill installation failed");
    return { ...(await result.json<any>()), source: { repository: extensionRepositoryView(row), path: requested } };
  }
  private skills(): any[] {
    return this.rows<any>("SELECT * FROM skills ORDER BY name").map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));
  }
  private createSkill(input: any): any {
    const name = String(input.name ?? "").trim();
    const instructions = String(input.instructions ?? "");
    if (
      !name ||
      name.length > 120 ||
      !instructions ||
      instructions.length > 20_000
    )
      throw new HttpError(400, "name and bounded instructions are required");
    const now = isoNow();
    const item = {
      id: id("skill"),
      name,
      description: String(input.description ?? "").slice(0, 500),
      instructions,
      createdAt: now,
      updatedAt: now,
    };
    this.state.storage.sql.exec(
      "INSERT INTO skills VALUES (?,?,?,?,?,?)",
      item.id,
      item.name,
      item.description,
      item.instructions,
      now,
      now,
    );
    return item;
  }
  private updateSkill(skillId: string, input: any): any {
    const old = this.one<any>("SELECT * FROM skills WHERE id=?", skillId);
    if (!old) throw new HttpError(404, "skill not found");
    const name =
      input.name === undefined ? old.name : String(input.name).trim();
    const description =
      input.description === undefined
        ? old.description
        : String(input.description).slice(0, 500);
    const instructions =
      input.instructions === undefined
        ? old.instructions
        : String(input.instructions);
    if (
      !name ||
      name.length > 120 ||
      !instructions ||
      instructions.length > 20_000
    )
      throw new HttpError(400, "invalid skill fields");
    const now = isoNow();
    this.state.storage.sql.exec(
      "UPDATE skills SET name=?,description=?,instructions=?,updated_at=? WHERE id=?",
      name,
      description,
      instructions,
      now,
      skillId,
    );
    return {
      id: skillId,
      name,
      description,
      instructions,
      createdAt: old.created_at,
      updatedAt: now,
    };
  }
  private deleteSkill(skillId: string): any {
    const result = this.state.storage.sql.exec(
      "DELETE FROM skills WHERE id=?",
      skillId,
    );
    if (!result.rowsWritten) throw new HttpError(404, "skill not found");
    this.state.storage.sql.exec(
      "DELETE FROM bot_skills WHERE skill_id=?",
      skillId,
    );
    return { deleted: true, id: skillId };
  }
  private botSkills(botId: string): any[] {
    if (!this.one("SELECT id FROM bots WHERE id=?", botId))
      throw new HttpError(404, "bot not found");
    return this.rows<any>(
      "SELECT s.* FROM skills s JOIN bot_skills bs ON bs.skill_id=s.id WHERE bs.bot_id=? ORDER BY s.name",
      botId,
    ).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));
  }
  private assignSkills(botId: string, input: any): any[] {
    if (!this.one("SELECT id FROM bots WHERE id=?", botId))
      throw new HttpError(404, "bot not found");
    if (
      !Array.isArray(input.skillIds) ||
      input.skillIds.some((v: any) => typeof v !== "string")
    )
      throw new HttpError(400, "skillIds must be an array of ids");
    const ids = [...new Set(input.skillIds)];
    if (ids.length) {
      if (
        ids.length !==
        this.rows(
          "SELECT id FROM skills WHERE id IN (" +
            ids.map(() => "?").join(",") +
            ")",
          ...ids,
        ).length
      )
        throw new HttpError(404, "one or more skills not found");
    }
    this.state.storage.sql.exec("DELETE FROM bot_skills WHERE bot_id=?", botId);
    for (const skillId of ids)
      this.state.storage.sql.exec(
        "INSERT INTO bot_skills VALUES (?,?,?)",
        botId,
        skillId,
        isoNow(),
      );
    return this.botSkills(botId);
  }
  private delegationView(row: any): any {
    return {
      id: row.id,
      sourceBotId: row.source_bot_id,
      sourceBotName: row.source_bot_name,
      sourceThreadId: row.source_thread_id,
      targetBotId: row.target_bot_id,
      targetBotName: row.target_bot_name,
      targetThreadId: row.target_thread_id,
      targetThreadTitle: row.target_thread_title,
      targetRunId: row.target_run_id,
      prompt: row.prompt,
      idempotencyKey: row.idempotency_key,
      status: row.run_status,
      ...(row.run_result !== null && row.run_result !== undefined
        ? { result: row.run_result }
        : {}),
      ...(row.run_error ? { error: row.run_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  private delegations(threadId: string): any[] {
    if (!this.one("SELECT id FROM threads WHERE id=?", threadId))
      throw new HttpError(404, "conversation not found");
    return this.rows<any>(
      `SELECT d.*, sb.name AS source_bot_name, tb.name AS target_bot_name,
        tt.title AS target_thread_title,
        CASE WHEN cr.id IS NOT NULL THEN cr.status ELSE r.status END AS run_status,
        COALESCE(cr.result,r.result) AS run_result,
        COALESCE(cr.error,r.error) AS run_error, r.updated_at AS run_updated_at
       FROM delegations d
       JOIN bots sb ON sb.id=d.source_bot_id
       JOIN bots tb ON tb.id=d.target_bot_id
       JOIN threads tt ON tt.id=d.target_thread_id
       JOIN runs r ON r.id=d.target_run_id
       LEFT JOIN delegation_continuations dc ON dc.source_run_id=d.target_run_id
       LEFT JOIN runs cr ON cr.id=dc.continuation_run_id
       WHERE d.source_thread_id=? ORDER BY d.created_at DESC`,
      threadId,
    ).map((row) => this.delegationView(row));
  }
  private botDirectory(excludeBotId?: string): Array<{ id: string; name: string }> {
    return this.rows<any>("SELECT id,name FROM bots ORDER BY created_at").map((bot) => ({
      id: bot.id,
      name: bot.name,
    })).filter((bot) => bot.id !== excludeBotId);
  }
  private createDelegation(sourceThreadId: string, input: any): any {
    const source = this.one<any>(
      "SELECT t.*, b.name AS source_bot_name FROM threads t JOIN bots b ON b.id=t.bot_id WHERE t.id=?",
      sourceThreadId,
    );
    if (!source) throw new HttpError(404, "source conversation not found");
    const targetBotId =
      typeof input.targetBotId === "string" ? input.targetBotId.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const idempotencyKey =
      typeof input.idempotencyKey === "string"
        ? input.idempotencyKey.trim()
        : "";
    if (!targetBotId) throw new HttpError(400, "targetBotId is required");
    if (!prompt || prompt.length > 20_000)
      throw new HttpError(400, "prompt must contain 1–20000 characters");
    if (!idempotencyKey || idempotencyKey.length > 160)
      throw new HttpError(400, "idempotencyKey must contain 1–160 characters");
    if (targetBotId === source.bot_id)
      throw new HttpError(400, "delegation target must be a different bot");
    const target = this.one<any>("SELECT * FROM bots WHERE id=?", targetBotId);
    if (!target) throw new HttpError(404, "target bot not found");
    // Automatic loop detection follows the current run chain. A fresh user
    // message in a previously delegated conversation starts a new chain.
    const sourceRunId = typeof input.sourceRunId === "string" ? input.sourceRunId : undefined;
    if (sourceRunId && !this.one("SELECT id FROM runs WHERE id=? AND thread_id=?", sourceRunId, sourceThreadId)) throw new HttpError(400, "source run does not belong to this conversation");
    let ancestorId = sourceRunId ?? sourceThreadId;
    for (let depth = 0; depth < 16; depth += 1) {
      const ancestor = this.one<any>(sourceRunId
        ? "SELECT source_bot_id,source_run_id FROM delegations WHERE target_run_id=? LIMIT 1"
        : "SELECT source_bot_id,source_thread_id FROM delegations WHERE target_thread_id=? ORDER BY created_at DESC LIMIT 1", ancestorId);
      if (!ancestor) break;
      if (ancestor.source_bot_id === targetBotId) throw new HttpError(400, "delegation would create a bot loop");
      if (depth === 15) throw new HttpError(400, "bot messaging chain limit reached");
      ancestorId = sourceRunId ? ancestor.source_run_id : ancestor.source_thread_id;
      if (!ancestorId) break;
    }
    const existing = this.one<any>(
      "SELECT * FROM delegations WHERE idempotency_key=?",
      idempotencyKey,
    );
    if (existing) {
      if (
        existing.source_thread_id !== sourceThreadId ||
        existing.target_bot_id !== targetBotId ||
        existing.prompt !== prompt
      )
        throw new HttpError(
          409,
          "idempotency key conflicts with an existing delegation",
        );
      return this.delegationView(
        this.one<any>(
          `SELECT d.*, sb.name AS source_bot_name, tb.name AS target_bot_name, tt.title AS target_thread_title,
          r.status AS run_status, r.result AS run_result, r.error AS run_error
         FROM delegations d JOIN bots sb ON sb.id=d.source_bot_id JOIN bots tb ON tb.id=d.target_bot_id
         JOIN threads tt ON tt.id=d.target_thread_id JOIN runs r ON r.id=d.target_run_id WHERE d.id=?`,
          existing.id,
        ),
      );
    }
    if (this.one("SELECT id FROM runs WHERE idempotency_key=?", idempotencyKey))
      throw new HttpError(
        409,
        "idempotency key is already used by another run",
      );
    const sourceLabel = `${source.source_bot_name} / ${source.title}`;
    const targetThread = this.createThread({
      botId: targetBotId,
      title: `From ${sourceLabel}`,
    });
    const delegatedPrompt = `[Message from bot "${source.source_bot_name}" in conversation "${source.title}"]\n\n${prompt}`;
    const targetRun = this.createRun({
      threadId: targetThread.id,
      prompt: delegatedPrompt,
      idempotencyKey,
    });
    const delegationId = id("delegation");
    const now = isoNow();
    this.state.storage.sql.exec(
      "INSERT INTO delegations (id,source_bot_id,source_thread_id,target_bot_id,target_thread_id,target_run_id,prompt,idempotency_key,created_at,updated_at,source_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      delegationId,
      source.bot_id,
      sourceThreadId,
      targetBotId,
      targetThread.id,
      targetRun.id,
      prompt,
      idempotencyKey,
      now,
      now,
      sourceRunId ?? null,
    );
    return this.delegationView(
      this.one<any>(
        `SELECT d.*, sb.name AS source_bot_name, tb.name AS target_bot_name, tt.title AS target_thread_title,
        r.status AS run_status, r.result AS run_result, r.error AS run_error
       FROM delegations d JOIN bots sb ON sb.id=d.source_bot_id JOIN bots tb ON tb.id=d.target_bot_id
       JOIN threads tt ON tt.id=d.target_thread_id JOIN runs r ON r.id=d.target_run_id WHERE d.id=?`,
        delegationId,
      ),
    );
  }
  private createThread(input: any): any {
    const bot = this.one<any>(
      "SELECT id,node_id FROM bots WHERE id = ?",
      input.botId,
    );
    if (!bot) throw new HttpError(404, "bot not found");
    if (!input.title || typeof input.title !== "string")
      throw new HttpError(400, "title is required");
    const nodeId =
      input.nodeId === undefined
        ? (bot.node_id ?? null)
        : input.nodeId === null || input.nodeId === ""
          ? null
          : String(input.nodeId);
    if (nodeId) this.assertAssignableNode(nodeId);
    const now = isoNow();
    const item = {
      id: id("thr"),
      botId: input.botId,
      title: input.title.trim().slice(0, 200),
      nodeId: nodeId ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.state.storage.sql.exec(
      "INSERT INTO threads (id,bot_id,title,node_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      item.id,
      item.botId,
      item.title,
      nodeId,
      now,
      now,
    );
    return item;
  }
  private admitMessage(input: any): any {
    if (this.maintenance) throw new HttpError(409, "computer maintenance is in progress");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.idempotencyKey !== "string" || !input.idempotencyKey || typeof input.threadId !== "string" || input.command || input.commandName || input.sessionAction) return this.createRun(input);
    const attachments = this.canonicalAttachments(input.attachments);
    const existing = this.one<any>("SELECT * FROM message_inputs WHERE idempotency_key=?", input.idempotencyKey);
    if (existing) {
      if (existing.thread_id !== input.threadId || existing.prompt !== input.prompt) throw new HttpError(409, "idempotency key conflicts with an existing message");
      if (parseJson(existing.attachments, []).map((item: any) => item.id).join(",") !== attachments.map((item: any) => item.id).join(",")) throw new HttpError(409, "idempotency key conflicts with an existing message");
      return { ...this.run(this.one("SELECT * FROM runs WHERE id=?", existing.run_id)), messageQueued: true };
    }
    if (this.one("SELECT id FROM runs WHERE idempotency_key=?", input.idempotencyKey)) return this.createRun(input);
    const active = this.one<any>("SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.thread_id=? AND t.node_id IS NULL AND r.status IN ('running','waiting_approval') ORDER BY r.created_at LIMIT 1", input.threadId);
    if (!active) return this.createRun({ ...input, attachments });
    if (input.prompt.length > 16000) throw new HttpError(400, "message must contain at most 16000 characters");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.idempotencyKey)) throw new HttpError(400, "invalid message idempotency key");
    const now=isoNow();
    this.state.storage.sql.exec("INSERT INTO message_inputs (idempotency_key,thread_id,run_id,prompt,status,attachments,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", input.idempotencyKey,input.threadId,active.id,input.prompt,"pending",attachments.length ? json(attachments) : null,now,now);
    this.state.storage.sql.exec("INSERT INTO messages (id,thread_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?)", id("msg"),input.threadId,"user",input.prompt,attachments.length ? json(attachments) : null,now);
    this.event(active.id,"message.queued",{id:input.idempotencyKey,delivery:"steer"});
    this.state.storage.setAlarm(Date.now()+100);
    return {...this.run(active),messageQueued:true};
  }
  private async flushMessageInputs(): Promise<void> {
    const pending=this.rows<any>("SELECT * FROM message_inputs WHERE status IN ('pending','dispatching') ORDER BY created_at LIMIT 4");
    for(const input of pending){
      const run=this.one<any>("SELECT * FROM runs WHERE id=?",input.run_id);
      if(!run) continue;
      if(TERMINAL.has(run.status) && input.status==='pending'){
        const queued=this.createRun({threadId:input.thread_id,prompt:input.prompt,idempotencyKey:input.idempotency_key,attachments:parseJson(input.attachments,[])},false);
        this.state.storage.sql.exec("UPDATE message_inputs SET status='queued',run_id=?,updated_at=? WHERE idempotency_key=?",queued.id,isoNow(),input.idempotency_key);
        continue;
      }
      this.state.storage.sql.exec("UPDATE message_inputs SET status='dispatching',updated_at=? WHERE idempotency_key=?",isoNow(),input.idempotency_key);
      try {
        const transport=await this.transport();
        const inputAttachments = parseJson<any[]>(input.attachments, []);
        const result=await transport.fetch(`/runs/${input.run_id}/messages`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({idempotencyKey:input.idempotency_key,prompt:input.prompt,delivery:"steer",...(inputAttachments.length ? { attachments: inputAttachments } : {})})});
        const receipt=await result.json() as any;
        if(result.ok && receipt.status==='accepted'){
          this.state.storage.sql.exec("UPDATE message_inputs SET status='accepted',native_id=?,updated_at=? WHERE idempotency_key=?",receipt.id??null,isoNow(),input.idempotency_key);
          this.event(input.run_id,"message.accepted",{id:input.idempotency_key,delivery:"steer"});
        }else if(result.status===409 && receipt.notAdmitted===true){
          const queued=this.createRun({threadId:input.thread_id,prompt:input.prompt,idempotencyKey:input.idempotency_key,attachments:parseJson(input.attachments,[])},false);
          this.state.storage.sql.exec("UPDATE message_inputs SET status='queued',run_id=?,updated_at=? WHERE idempotency_key=?",queued.id,isoNow(),input.idempotency_key);
        }else{
          this.state.storage.sql.exec("UPDATE message_inputs SET status='needs_review',updated_at=? WHERE idempotency_key=?",isoNow(),input.idempotency_key);
          this.event(input.run_id,"message.delivery.uncertain",{id:input.idempotency_key,reason:"Message delivery could not be confirmed; it was not replayed."});
        }
      }catch{
        // Keep the same durable ID. The runner deduplicates this receipt on retry.
        this.state.storage.setAlarm(Date.now()+3000);
      }
    }
  }
  private createRun(input: any, recordUserMessage = true): any {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    if (input.command && input.sessionAction)
      throw new HttpError(400, "choose a command or session action");
    if (input.command)
      input = {
        ...input,
        commandName: String(input.command.name ?? "").replace(/^\//, ""),
        commandText: String(input.command.text ?? ""),
      };
    if (input.sessionAction && typeof input.sessionAction === "object")
      input = {
        ...input,
        sessionAction: String(input.sessionAction.name ?? ""),
        sessionActionInput: input.sessionAction.input ?? {},
      };
    if (
      input.commandName &&
      !/^[A-Za-z0-9._:-]{1,120}$/.test(input.commandName)
    )
      throw new HttpError(400, "invalid command name");
    if (
      input.sessionAction &&
      ![
        "compact",
        "undo",
        "redo",
        "revert-stage",
        "revert-clear",
        "revert-commit",
      ].includes(input.sessionAction)
    )
      throw new HttpError(400, "unknown session action");
    if (
      input.sessionAction === "undo" ||
      input.sessionAction === "revert-stage"
    ) {
      if (!input.sessionActionInput?.messageID)
        throw new HttpError(400, "select a native message to undo");
    }
    input = {
      ...input,
      attachments: this.canonicalAttachments(input.attachments),
      prompt:
        input.prompt ||
        (input.attachments?.length ? "Review the attached file." :
        (input.commandName
          ? `/${input.commandName} ${input.commandText ?? ""}`.trim()
          : input.sessionAction
            ? `/${input.sessionAction}`
            : "")),
    };
    if (!input.threadId || !input.prompt || !input.idempotencyKey)
      throw new HttpError(
        400,
        "threadId, prompt, and idempotencyKey are required",
      );
    const thread = this.one<any>(
      "SELECT id,node_id FROM threads WHERE id = ?",
      input.threadId,
    );
    if (!thread) throw new HttpError(404, "thread not found");
    if (input.attachments.length && thread.node_id)
      throw new HttpError(409, "Attachments for owned computer nodes are not supported yet; choose the Cloudflare computer.");
    const existing = this.one<any>(
      "SELECT * FROM runs WHERE idempotency_key = ?",
      String(input.idempotencyKey),
    );
    if (existing) {
      if (
        existing.thread_id !== input.threadId ||
        existing.prompt !== String(input.prompt) ||
        (existing.command_name ?? "") !== (input.commandName ?? "") ||
        (existing.command_text ?? "") !== (input.commandText ?? "") ||
        (existing.session_action ?? "") !== (input.sessionAction ?? "") ||
        (existing.session_action_input ?? "") !==
          (input.sessionActionInput ? json(input.sessionActionInput) : "")
        || parseJson(existing.attachments, []).map((item: any) => item.id).join(",") !== input.attachments.map((item: any) => item.id).join(",")
      )
        throw new HttpError(
          409,
          "idempotency key conflicts with an existing run",
        );
      return {
        ...this.run(existing),
        events: this.events(existing.id),
        deduplicated: true,
      };
    }
    const now = isoNow();
    const runId = id("run");
    const commandName = input.commandName ? String(input.commandName) : null;
    const commandText = input.commandText ? String(input.commandText) : null;
    // Continuations are internal control-plane turns. Keep their prompt in
    // the run receipt, but do not present it as a user-authored message.
    if (input.allowBotMessaging !== false && recordUserMessage)
      this.state.storage.sql.exec(
        "INSERT INTO messages (id,thread_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?)",
        id("msg"),
        input.threadId,
        "user",
        String(input.prompt),
        input.attachments?.length ? json(input.attachments) : null,
        now,
      );
    this.state.storage.sql.exec(
      "INSERT INTO runs (id,thread_id,prompt,status,idempotency_key,created_at,updated_at,command_name,command_text,session_action,session_action_input,bot_messaging,attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      runId,
      input.threadId,
      String(input.prompt),
      "queued",
      String(input.idempotencyKey),
      now,
      now,
      commandName,
      commandText,
      input.sessionAction ?? null,
      input.sessionActionInput ? json(input.sessionActionInput) : null,
      input.allowBotMessaging === false ? 0 : 1,
      input.attachments.length ? json(input.attachments) : null,
    );
    this.event(runId, "run.queued", { prompt: String(input.prompt) });
    this.state.storage.setAlarm(Date.now() + 100);
    return {
      ...this.run(this.one("SELECT * FROM runs WHERE id = ?", runId)),
      events: this.events(runId),
      deduplicated: false,
    };
  }
  private createActionRun(threadId: string, input: any): any {
    const command =
      input.command && typeof input.command === "object" ? input.command : null;
    const action =
      input.sessionAction && typeof input.sessionAction === "object"
        ? input.sessionAction
        : null;
    if ((command ? 1 : 0) + (action ? 1 : 0) !== 1)
      throw new HttpError(400, "provide exactly one command or sessionAction");
    const source = command ?? action;
    const name = String(source.name ?? "")
      .replace(/^\//, "")
      .trim();
    if (!name || !/^[A-Za-z0-9._:-]{1,120}$/.test(name))
      throw new HttpError(400, "command/action name is invalid");
    const text = String(command?.text ?? "");
    return this.createRun({
      threadId,
      prompt: text || name,
      idempotencyKey: String(
        input.idempotencyKey || `${threadId}:${name}:${Date.now()}`,
      ),
      commandName: command ? name : null,
      commandText: text,
      sessionAction: action ? name : null,
      sessionActionInput: action?.input ?? {},
    });
  }
  private runView(runId: string): any {
    const item = this.one("SELECT * FROM runs WHERE id = ?", runId);
    if (!item) throw new HttpError(404, "run not found");
    const pending = this.one<any>(
      "SELECT request_id,payload,created_at FROM approvals WHERE run_id=? AND decision IS NULL ORDER BY created_at LIMIT 1",
      runId,
    );
    return {
      ...this.run(item),
      events: this.events(runId),
      ...(pending
        ? {
            pendingApproval: {
              requestId: pending.request_id,
              payload: parseJson(pending.payload, null),
              createdAt: pending.created_at,
            },
          }
        : {}),
    };
  }
  private async runAction(runId: string, input: any): Promise<any> {
    if (input.action !== "cancel")
      throw new HttpError(400, "only cancel is supported");
    const item = this.one<any>("SELECT * FROM runs WHERE id = ?", runId);
    if (!item) throw new HttpError(404, "run not found");
    const affinity = this.one<any>(
      "SELECT node_id FROM threads WHERE id=?",
      item.thread_id,
    );
    if (!TERMINAL.has(item.status)) {
      if (item.status === "queued" || item.status === "waiting_dependency")
        this.transition(runId, item.status, "cancelled", { reason: "user" });
      else if (canTransition(item.status, "cancelling")) {
        this.transition(runId, item.status, "cancelling", { reason: "user" });
        if (affinity?.node_id) {
          try {
            await this.enqueueOwnedCommand(item, {
              kind: "runner.cancel",
              runId,
            });
          } catch (error) {
            this.event(runId, "cancel.forward_error", { error: String(error) });
            const current = this.one<any>(
              "SELECT status FROM runs WHERE id=?",
              runId,
            );
            if (current && canTransition(current.status, "needs_review"))
              this.transition(runId, current.status, "needs_review", {
                reason: "owned node cancel could not be queued",
              });
          }
        } else {
          try {
            const transport = await this.transport();
            const result = await transport.fetch(`/runs/${runId}/cancel`, { method: "POST" });
            if (!result.ok) throw new Error(`runner cancel HTTP ${result.status}`);
          } catch (error) {
            this.event(runId, "cancel.forward_error", { error: String(error) });
          }
        }
        this.state.storage.setAlarm(Date.now() + 50);
      }
    }
    return this.runView(runId);
  }
  private transition(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    payload: unknown,
  ): void {
    assertTransition(from, to);
    const now = isoNow();
    this.state.storage.sql.exec(
      "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
      to,
      now,
      runId,
    );
    this.event(runId, `run.${to}`, payload);
  }
  private async approve(runId: string, input: any): Promise<any> {
    const requestId = String(input.requestId ?? "");
    const decision = input.decision as Decision;
    if (!requestId || !["approve", "deny"].includes(decision))
      throw new HttpError(
        400,
        "requestId and decision (approve|deny) are required",
      );
    const run = this.one<any>("SELECT * FROM runs WHERE id = ?", runId);
    if (!run) throw new HttpError(404, "run not found");
    const affinity = this.one<any>(
      "SELECT node_id FROM threads WHERE id=?",
      run.thread_id,
    );
    const pending = this.one<any>(
      "SELECT * FROM approvals WHERE request_id=? AND run_id=? AND decision IS NULL",
      requestId,
      runId,
    );
    if (!pending)
      throw new HttpError(
        409,
        "approval request is unknown, already decided, or belongs to another run",
      );
    const now = isoNow();
    const changed = this.state.storage.sql.exec(
      "UPDATE approvals SET decision=?,updated_at=? WHERE request_id=? AND run_id=? AND decision IS NULL",
      decision,
      now,
      requestId,
      runId,
    );
    if (!changed.rowsWritten)
      throw new HttpError(409, "approval was already decided");
    this.event(runId, "approval.decided", { requestId, decision });
    let forwarded = true;
    try {
      if (affinity?.node_id)
        await this.enqueueOwnedCommand(run, {
          kind: "runner.approval",
          runId,
          requestId,
          decision,
        });
      else {
        const transport = await this.transport();
        const result = await transport.fetch(`/runs/${runId}/approval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, decision }),
        });
        if (!result.ok)
          throw new Error(`runner approval HTTP ${result.status}`);
      }
    } catch (error) {
      forwarded = false;
      this.event(runId, "approval.forward_error", { error: String(error) });
    }
    const current = this.one<any>("SELECT status FROM runs WHERE id=?", runId);
    if (
      !forwarded &&
      current &&
      !TERMINAL.has(current.status) &&
      canTransition(current.status, "needs_review")
    )
      this.transition(runId, current.status, "needs_review", {
        reason: "approval forwarding failed",
        requestId,
      });
    else if (forwarded && current?.status === "waiting_approval")
      this.transition(
        runId,
        current.status,
        decision === "approve" ? "running" : "needs_review",
        { requestId, decision },
      );
    this.state.storage.setAlarm(Date.now() + 50);
    return this.runView(runId);
  }
  private async memoryRoute(
    request: Request,
    botId: string,
  ): Promise<Response> {
    if (!this.one("SELECT id FROM bots WHERE id = ?", botId))
      throw new HttpError(404, "bot not found");
    if (request.method === "GET")
      return response(
        this.rows<any>(
          "SELECT * FROM memory_items WHERE bot_id = ? ORDER BY created_at DESC",
          botId,
        ).map((m) => ({
          id: m.id,
          botId,
          content: m.content,
          kind: m.kind,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        })),
      );
    const remove = request.url.match(/\/memory\/([^/]+)$/);
    if (remove && request.method === "DELETE") {
      const result = this.state.storage.sql.exec(
        "DELETE FROM memory_items WHERE id = ? AND bot_id = ?",
        remove[1],
        botId,
      );
      if (!result.rowsWritten)
        throw new HttpError(404, "memory item not found");
      return response({ deleted: true, id: remove[1] });
    }
    if (request.method !== "POST")
      throw new HttpError(405, "method not allowed");
    const input = await body(request);
    if (!input.content) throw new HttpError(400, "content is required");
    const now = isoNow();
    const item = {
      id: id("mem"),
      botId,
      content: String(input.content),
      kind: String(input.kind ?? "fact"),
      createdAt: now,
      updatedAt: now,
    };
    this.state.storage.sql.exec(
      "INSERT INTO memory_items VALUES (?,?,?,?,?,?)",
      item.id,
      botId,
      item.content,
      item.kind,
      now,
      now,
    );
    return response(item, 201);
  }

  async alarm(): Promise<void> {
    this.init();
    if (typeof this.state.storage.get === "function" && await this.updates().active()) {
      this.maintenance = true;
      try { await this.updates().resume(); }
      finally { this.maintenance = await this.updates().active(); }
      return;
    }
    if (this.maintenance) {
      this.state.storage.setAlarm(Date.now() + 1000);
      return;
    }
    await this.flushMessageInputs();
    let run = this.one<any>(
      "SELECT * FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling') ORDER BY CASE WHEN status IN ('provisioning','running','waiting_approval','cancelling') THEN 0 ELSE 1 END, created_at, rowid LIMIT 1",
    );
    await this.pollTelegram();
    await this.deliverTelegramProgress();
    await this.deliverTelegramResults();
    await this.fireRoutines();
    await this.advancePendingContinuations();
    run = this.one<any>(
      "SELECT * FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling') ORDER BY CASE WHEN status IN ('provisioning','running','waiting_approval','cancelling') THEN 0 ELSE 1 END, created_at, rowid LIMIT 1",
    );
    if (!run) {
      this.schedule();
      return;
    }
    const affinity = this.one<{ node_id?: string }>(
      "SELECT node_id FROM threads WHERE id=?",
      run.thread_id,
    );
    if (affinity?.node_id) {
      try {
        await this.reconcileOwnedNode(run, affinity.node_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.event(run.id, "node.reconcile_error", {
          nodeId: affinity.node_id,
          error: message,
        });
        const current = this.one<any>(
          "SELECT status FROM runs WHERE id=?",
          run.id,
        );
        if (current && canTransition(current.status, "needs_review"))
          this.transition(run.id, current.status, "needs_review", {
            reason: "owned node reconciliation failed",
            error: message,
          });
      }
      if (
        this.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling')",
        )?.n
      )
        this.state.storage.setAlarm(Date.now() + 3000);
      this.schedule();
      return;
    }
    if (!this.env.SANDBOX || !this.env.RUNNER_TOKEN) {
      if (run.status === "queued")
        this.transition(run.id, run.status, "waiting_dependency", {
          dependency: "SANDBOX/RUNNER_TOKEN",
        });
      return;
    }
    try {
      const runner = await this.runner(run);
      if (runner.status === "missing") {
        if (run.status === "queued") await this.dispatch(run);
        else if (
          run.status === "provisioning" ||
          run.status === "running" ||
          run.status === "waiting_approval" ||
          run.status === "cancelling"
        )
          this.transition(run.id, run.status, "needs_review", {
            reason: "runner receipt disappeared; refusing replay",
          });
      } else await this.reconcile(run, runner.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.event(run.id, "runner.reconcile_error", { error: message });
      if (
        message.includes("explicit restore required") ||
        message.includes("recovery required") ||
        message.includes("state_unknown")
      ) {
        const current = this.one<any>(
          "SELECT status FROM runs WHERE id=?",
          run.id,
        );
        if (current?.status === "queued")
          this.transition(run.id, current.status, "waiting_dependency", {
            dependency: "computer_checkpoint_restore",
          });
        else if (current && canTransition(current.status, "needs_review"))
          this.transition(run.id, current.status, "needs_review", {
            reason: "computer checkpoint restore required",
          });
      }
    }
    await this.deliverTelegramProgress();
    await this.deliverTelegramResults();
    if (
      this.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling')",
      )?.n
      || this.one<{ n: number }>("SELECT COUNT(*) AS n FROM delegation_continuations WHERE status='pending'")?.n
      || this.one<{ n: number }>("SELECT COUNT(*) AS n FROM message_inputs WHERE status IN ('pending','dispatching')")?.n
    )
      this.state.storage.setAlarm(Date.now() + 3000);
    this.schedule();
  }
  private schedule(): void {
    const due = this.one<any>(
      "SELECT MIN(CAST(strftime('%s',next_run_at) AS INTEGER)*1000) AS at FROM routines WHERE enabled=1",
    );
    const active =
      this.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling')",
      )?.n ?? 0;
    this.telegram();
    const polling = this.one<any>(
      "SELECT COUNT(*) AS n FROM telegram_bot_configs WHERE transport='polling'",
    )?.n;
    const inputs = this.one<{n:number}>("SELECT COUNT(*) AS n FROM message_inputs WHERE status IN ('pending','dispatching')")?.n;
    const wake = Math.min(
      inputs ? Date.now() + 3000 : Infinity,
      polling ? Date.now() + 5000 : Infinity,
      due?.at ? Number(due.at) : Infinity,
      active ? Date.now() + 3000 : Infinity,
    );
    if (Number.isFinite(wake))
      this.state.storage.setAlarm(Math.max(Date.now() + 100, wake));
  }
  private async fireRoutines(): Promise<void> {
    const now = Date.now();
    const due = this.rows<any>(
      "SELECT * FROM routines WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 20",
      new Date(now).toISOString(),
    );
    for (const routine of due) {
      const active = this.one(
        "SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','provisioning','running','waiting_approval','waiting_human','recovering','cancelling')",
        routine.thread_id,
      );
      const dueAt = Date.parse(routine.next_run_at);
      const next = advanceDue(dueAt, routine.interval_minutes, now);
      this.state.storage.sql.exec(
        "UPDATE routines SET next_run_at=?,updated_at=? WHERE id=? AND next_run_at=?",
        new Date(next).toISOString(),
        isoNow(),
        routine.id,
        routine.next_run_at,
      );
      if (active) continue;
      const key = `routine:${routine.id}:${routine.next_run_at}`;
      if (this.one("SELECT id FROM runs WHERE idempotency_key=?", key))
        continue;
      const created = this.createRun({
        threadId: routine.thread_id,
        prompt: routine.prompt,
        idempotencyKey: key,
      });
      this.event(created.id, "routine.triggered", {
        routineId: routine.id,
        scheduledAt: routine.next_run_at,
      });
    }
  }

  private provider(): CloudflareComputerProvider {
    if (!this.env.SANDBOX || !this.env.RUNNER_TOKEN)
      throw new Error("SANDBOX and RUNNER_TOKEN are required");
    // Sandbox reserves port 3000 for its container server; the application
    // runner listens on the image's private 8787 port.
    this.computerProvider ??= new CloudflareComputerProvider({
      sandboxNamespace: this.env.SANDBOX,
      defaultRunnerPort: 8787,
      checkpointBucket: this.env.ARTIFACTS,
    });
    return this.computerProvider;
  }
  private computerManager(): ComputerManager {
    this.computerCoordinator ??= new ComputerManager(
      this.provider(),
      new DurableObjectCheckpointStore(this.state.storage),
    );
    return this.computerCoordinator;
  }
  private async computerGeneration(): Promise<number> {
    if (typeof this.state.storage.get !== "function") return 1;
    return (await this.state.storage.get<number>("computer-generation")) ?? 1;
  }
  private updates(origin?: URL): UpdateController {
    return this.updateController ??= new UpdateController({
      storage: this.state.storage,
      currentVersion: packageInfo.version,
      identity: {
        accountId: this.env.APP_ACCOUNT_ID,
        workerName: this.env.APP_WORKER_NAME ?? (origin?.hostname.endsWith(".workers.dev") ? origin.hostname.split(".")[0] : undefined),
      },
      schedule: () => { this.state.storage.setAlarm(Date.now() + 5000); },
      lifecycle: {
        assertIdle: async () => {
          const active = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('succeeded','failed','cancelled','needs_review')")?.n ?? 0;
          const inputs = this.one<{n:number}>("SELECT COUNT(*) AS n FROM message_inputs WHERE status IN ('pending','dispatching')")?.n;
          if (active || inputs) throw new Error("Finish or stop active work before updating the app.");
        },
        checkpoint: async () => {
          const ready = await this.computerManager().prepare(await this.computerSpec());
          if (ready.state !== "ready") throw new Error("Restore the computer before updating the app.");
          const pointer = await this.computerManager().checkpoint("shared", await this.computerGeneration(), 0, ready.runnerState?.instanceId);
          const manifest = pointer.manifest;
          if (!manifest.supported || !manifest.durable || !manifest.sha256 || !manifest.checkpointKey || !this.env.ARTIFACTS) throw new Error("A durable Computer checkpoint is required before updating.");
          const saved = await this.env.ARTIFACTS.get(manifest.checkpointKey);
          if (!saved || saved.size !== manifest.bytes) throw new Error("Checkpoint verification failed. The app has not been changed.");
          const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await saved.arrayBuffer()))].map(v => v.toString(16).padStart(2, "0")).join("");
          if (digest !== manifest.sha256) throw new Error("Checkpoint verification failed. The app has not been changed.");
          return { id: manifest.id, sha256: `sha256:${manifest.sha256}` };
        },
        restore: async checkpointId => {
          this.computerProvider = undefined;
          this.computerCoordinator = undefined;
          this.startup.invalidate();
          const ready = await this.computerManager().prepare(await this.computerSpec());
          if (ready.committedCheckpoint?.manifest.id !== checkpointId) throw new Error("The saved update checkpoint could not be located.");
          if (ready.state !== "ready") await this.computerManager().restore("shared", ready.committedCheckpoint);
        },
        healthCheck: async () => {
          const ready = await this.computerManager().prepare(await this.computerSpec());
          if (ready.state !== "ready") throw new Error("The updated Computer is not ready yet.");
          const health = await ready.handle.transport.fetch("/health");
          if (!health.ok) throw new Error("The updated Computer did not pass its health check.");
          this.startup.invalidate();
        },
      },
    });
  }

  private async updateRoute(request: Request, url: URL): Promise<Response> {
    const updater = this.updates(url);
    try {
      if (url.pathname === "/api/updates" && request.method === "GET") return response(await updater.status(url.searchParams.has("refresh")));
      if (url.pathname === "/api/updates/configure" && request.method === "POST") return response(await updater.configure(await body(request)));
      if (url.pathname === "/api/updates/configure" && request.method === "DELETE") return response(await updater.removeConfiguration());
      if (request.method === "POST" && ["/api/updates", "/api/updates/recover"].includes(url.pathname)) {
        this.maintenance = true;
        try {
          const result = url.pathname.endsWith("/recover") ? await updater.recover() : await updater.start((await body(request)).version);
          return response(result, 202);
        } finally { this.maintenance = await updater.active(); }
      }
      throw new HttpError(404, "not found");
    } catch (error) {
      return response({ error: error instanceof Error ? error.message : "The update could not proceed." }, error instanceof HttpError ? error.status : 400);
    }
  }

  private computerReadiness(retry = false) {
    return this.startup.read(async () => {
      const readiness = await this.computerManager().prepare(await this.computerSpec());
      if (readiness.state !== "ready") throw new Error(`Computer recovery required (${readiness.state})`);
    }, (work) => this.state.waitUntil(work), retry);
  }

  private async computerStatus(): Promise<any> {
    const readiness = await this.computerManager().prepare(
      await this.computerSpec(),
    );
    return {
      ...readiness.handle.status,
      readiness: readiness.state,
      checkpoint: readiness.committedCheckpoint?.manifest ?? null,
      runnerState: readiness.runnerState ?? null,
    };
  }
  private async computerCheckpoint(): Promise<any> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    this.maintenance = true;
    try {
      const active =
        this.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','waiting_human','cancelling','recovering')",
        )?.n ?? 0;
      if (active > 0) throw new HttpError(409, "computer has active runs");
      const readiness = await this.computerManager().prepare(
        await this.computerSpec(),
      );
      if (readiness.state !== "ready")
        throw new HttpError(
          409,
          `computer requires restore before checkpoint (${readiness.state})`,
        );
      const pointer = await this.computerManager().checkpoint(
        "shared",
        await this.computerGeneration(),
        0,
        readiness.runnerState?.instanceId,
      );
      return {
        status: "committed",
        checkpoint: pointer.manifest,
        runnerInstanceId: pointer.runnerInstanceId,
        committedAt: pointer.committedAt,
      };
    } finally {
      this.maintenance = false;
    }
  }
  private async computerRestore(): Promise<any> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    this.maintenance = true;
    try {
      const active =
        this.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','waiting_human','cancelling','recovering')",
        )?.n ?? 0;
      if (active > 0) throw new HttpError(409, "computer has active runs");
      const readiness = await this.computerManager().prepare(
        await this.computerSpec(),
      );
      if (!readiness.committedCheckpoint)
        throw new HttpError(404, "no checkpoint exists");
      const pointer = await this.computerManager().restore(
        "shared",
        readiness.committedCheckpoint,
      );
      this.state.storage.sql.exec(
        "UPDATE runs SET status='queued',updated_at=? WHERE status='waiting_dependency'",
        isoNow(),
      );
      this.startup.invalidate();
      this.state.storage.setAlarm(Date.now() + 100);
      return {
        status: "restored",
        checkpoint: pointer.manifest,
        runnerInstanceId: pointer.runnerInstanceId,
      };
    } finally {
      this.maintenance = false;
    }
  }
  private async fileProxy(request: Request, url: URL): Promise<Response> {
    const listingRoot =
      url.pathname === "/api/files" &&
      request.method === "GET" &&
      (!url.searchParams.get("path") || url.searchParams.get("path") === ".");
    const path = listingRoot ? "." : url.searchParams.get("path");
    if (
      !listingRoot &&
      (!path ||
        path.length > 1000 ||
        path.startsWith("/") ||
        path
          .split(/[\\/]+/)
          .some(
            (part) =>
              !part || part === "." || part === ".." || part.startsWith("."),
          ))
    )
      throw new HttpError(400, "a safe explicit path is required");
    const transport = await this.transport();
    const target = `${url.pathname === "/api/files/content" ? "/files/content" : "/files"}?path=${encodeURIComponent(path!)}${url.searchParams.get("limit") ? `&limit=${encodeURIComponent(url.searchParams.get("limit")!)}` : ""}`;
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    let init: RequestInit = { method: request.method, headers };
    if (request.method === "POST") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 10_000_000) throw new HttpError(413, "file too large");
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 10_000_000)
        throw new HttpError(413, "file too large");
      init.body = bytes;
    }
    const result = await transport.fetch(target, init);
    const outHeaders = new Headers();
    for (const key of [
      "content-type",
      "content-length",
      "content-disposition",
      "cache-control",
    ]) {
      const value = result.headers.get(key);
      if (value) outHeaders.set(key, value);
    }
    return new Response(result.body, {
      status: result.status,
      headers: outHeaders,
    });
  }
  private canonicalAttachments(input: unknown): any[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_CHAT_ATTACHMENTS)
      throw new HttpError(400, "attachments must be an array of at most 8 items");
    const result: any[] = [];
    let totalBytes = 0;
    for (const item of input) {
      const attachmentId = typeof item === "string" ? item : item?.id;
      if (typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId))
        throw new HttpError(400, "attachment id is invalid");
      const row = this.one<any>("SELECT id,path,name,mime_type,size FROM chat_attachments WHERE id=?", attachmentId);
      if (!row) throw new HttpError(404, "attachment not found");
      totalBytes += Number(row.size);
      if (totalBytes > MAX_CHAT_ATTACHMENTS_BYTES) throw new HttpError(413, "attachments are too large");
      result.push({ id: row.id, path: row.path, name: row.name, mimeType: row.mime_type, size: Number(row.size) });
    }
    return result;
  }
  private async uploadAttachment(file: { bytes: ArrayBuffer; name: string; mimeType?: string }): Promise<any> {
    if (file.bytes.byteLength < 1 || file.bytes.byteLength > MAX_CHAT_UPLOAD_BYTES)
      throw new HttpError(413, "file too large");
    let name = (file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "upload";
    if (name.startsWith(".")) name = `_${name}`;
    const attachmentId = id("att");
    const path = `uploads/${attachmentId}/${name}`;
    const mimeType = typeof file.mimeType === "string" && file.mimeType.length <= 160 ? file.mimeType : "application/octet-stream";
    const transport = await this.transport();
    const result = await transport.fetch(`/files?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(file.bytes.byteLength) },
      body: file.bytes,
    });
    if (!result.ok) throw new HttpError(result.status >= 400 && result.status < 500 ? result.status : 502, "attachment upload failed");
    this.state.storage.sql.exec("INSERT INTO chat_attachments(id,path,name,mime_type,size,created_at) VALUES(?,?,?,?,?,?)", attachmentId, path, name, mimeType, file.bytes.byteLength, isoNow());
    return { id: attachmentId, name, mimeType, size: file.bytes.byteLength };
  }
  private async uploadRequest(request: Request): Promise<any> {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_CHAT_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, "file too large");
    let form: FormData;
    try {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_CHAT_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, "file too large");
      form = await new Request(request.url, { method: "POST", headers: request.headers, body: raw }).formData();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "multipart form data is required");
    }
    const item = form.get("file");
    if (!(item instanceof File)) throw new HttpError(400, "file is required");
    return { attachment: await this.uploadAttachment({ bytes: await item.arrayBuffer(), name: item.name, mimeType: item.type }) };
  }
  private async nativeMessages(threadId: string): Promise<Response> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    const thread = this.one<any>("SELECT * FROM threads WHERE id=?", threadId);
    if (!thread) throw new HttpError(404, "conversation not found");
    if (thread.node_id)
      throw new HttpError(
        409,
        "Conversation messages for owned nodes are available after the runner reports a result; native message browsing is unsupported.",
      );
    if (!thread.runner_session_id)
      return response({ sessionId: null, messages: [] });
    const transport = await this.transport();
    const result = await transport.fetch(
      `/sessions/${encodeURIComponent(thread.runner_session_id)}/messages`,
    );
    if (!result.ok) return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
    const payload = await result.json() as any;
    const internalPrompts = new Set(this.rows<any>("SELECT prompt FROM runs WHERE thread_id=? AND bot_messaging=0", threadId).map(run => run.prompt));
    const messages = (payload.messages ?? []).filter((message: any) => !(message.type === "user" && internalPrompts.has(message.text))).map((message: any) => ({
      ...message,
      files: Array.isArray(message.files) ? message.files.map((file: any) => {
        const uri = String(file?.source?.uri ?? file?.uri ?? file?.id ?? "");
        const match = uri.match(/(att_[0-9a-f-]{20,80})/i);
        const row = match ? this.one<any>("SELECT id,path,name,mime_type,size FROM chat_attachments WHERE id=?", match[1]) : undefined;
        return row ? { ...file, data: "", source: { type: "uri", uri: `file:///workspace/shared/${row.path}` }, id: row.id, name: row.name, mime: row.mime_type, mimeType: row.mime_type, size: Number(row.size) } : { ...file, data: "" };
      }) : message.files,
      content: Array.isArray(message.content) ? message.content.map((part: any) => {
        if (!(part?.type === "file" || part?.type === "image")) return part;
        const uri = String(part.uri ?? part.url ?? part.id ?? "");
        const match = uri.match(/(att_[0-9a-f-]{20,80})/i);
        const row = match ? this.one<any>("SELECT id,name,mime_type,size FROM chat_attachments WHERE id=?", match[1]) : undefined;
        return row ? { ...part, data: "", id: row.id, name: row.name, mime: row.mime_type, mimeType: row.mime_type, size: Number(row.size) } : { ...part, ...(part.data !== undefined ? { data: "" } : {}) };
      }) : message.content,
    }));
    return response({ ...payload, messages });
  }
  private botInstructions(thread: any): string {
    const memories = this.rows<any>(
      "SELECT content FROM memory_items WHERE bot_id=? ORDER BY updated_at DESC LIMIT 20",
      thread.bot_id,
    )
      .map((m) => m.content)
      .join("\n");
    const selectedSkills = this.rows<any>(
      "SELECT s.name,s.instructions FROM skills s JOIN bot_skills bs ON bs.skill_id=s.id WHERE bs.bot_id=? ORDER BY s.name",
      thread.bot_id,
    )
      .map((s) => `[Skill: ${s.name}]\n${s.instructions}`)
      .join("\n\n");
    const identity = this.one<any>(
      "SELECT name FROM bots WHERE id=?",
      thread.bot_id,
    );
    const peers = this.botDirectory()
      .filter((bot) => bot.id !== thread.bot_id)
      .map((bot) => `${bot.name} (${bot.id})`)
      .join(", ");
    const completedDelegations = this.rows<any>(
      `SELECT tb.name AS target_bot_name, d.prompt, r.status, r.result, r.error
       FROM delegations d JOIN bots tb ON tb.id=d.target_bot_id JOIN runs r ON r.id=d.target_run_id
       WHERE d.source_thread_id=? AND r.status IN ('succeeded','failed','cancelled','needs_review')
       ORDER BY r.updated_at DESC LIMIT 8`,
      thread.id,
    )
      .map((item) => {
        const result = String(item.result ?? item.error ?? "").slice(0, 6000);
        return `[Delegated to ${item.target_bot_name}; ${item.status}]\nRequest: ${String(item.prompt).slice(0, 1000)}\nResult: ${result}`;
      })
      .join("\n\n");
    return [
      identity
        ? `Your name is ${identity.name}. You are this user’s persistent bot, powered by OpenCode. Use your configured name when asked who you are.`
        : "",
      thread.instructions,
      "For a multi-step task, send a brief plain-language progress message before starting tool work, then short updates when you make a meaningful finding, switch approach, or begin a longer operation. Describe concrete actions and findings for the user; keep private reasoning private. Do not narrate every trivial step or repeat tool output. Keep working after each progress message until the requested task is complete or genuinely blocked.",
      !thread.node_id ? "Your computer has its own headed Chromium browser, visible in the app’s Computer preview. Use the computer_browser MCP tools (including computer_browser_browser_navigate, browser_snapshot, browser_click, browser_type and browser_tabs) to control that exact browser. These tools attach to the same browser shown in the live stream. The unrelated built-in tools.browser namespace expects an OpenCode desktop-app connection; do not use it for this computer. No desktop app, extension, or experimental browser setting is required. When asked to open or interact with a page, navigate with computer_browser and verify its page snapshot; fetching page text alone does not operate the live browser." : "",
      `Bot communication and creation are available through the runner MCP server named \`bots\`. Use \`list_bots\` to inspect peers, \`send_message\` to queue work for a peer, \`get_replies\` to inspect requests and completed results, and \`create_bot\` when the user asks you to define a new persistent workspace bot. New bots are created after this turn ends with their own persisted settings and conversations; they are independent persistent bots, not OpenCode subagents. Creation accepts a unique name, instructions, and optional model/agent. Never include owner credentials or tokens in bot definitions. For requests involving another named workspace bot, use these tools rather than subagent mode. After sending or creating, end your turn with a short natural acknowledgment. The recipient or newly created bot is available after the turn; never ask the user to send another message to retrieve it. Do not poll in a loop, display internal bot/request IDs, or claim a reply before it arrives. Available peers: ${peers || "none"}.`,
      memories ? `Relevant bot memory:\n${memories}` : "",
      selectedSkills
        ? `Assigned skills (workspace instruction bundles):\n${selectedSkills}`
        : "",
      completedDelegations
        ? `Completed delegation results (use as context, do not repeat automatically):\n${completedDelegations}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  private async terminalProxy(request: Request, url: URL): Promise<Response> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    let payload: any;
    let transport: any;
    if (request.method === "POST") payload = await body(request);
    if (url.pathname === "/api/terminal" && request.method === "POST") {
      const thread = this.one<any>(
        "SELECT t.*, b.model, b.agent, b.instructions FROM threads t JOIN bots b ON b.id=t.bot_id WHERE t.id=?",
        String(payload.threadId ?? ""),
      );
      if (!thread) throw new HttpError(404, "conversation not found");
      if (thread.node_id)
        throw new HttpError(
          409,
          "Native terminal is unavailable for owned nodes; run the conversation through the runner API instead.",
        );
      transport = await this.transport();
      if (
        this.one(
          "SELECT id FROM runs WHERE status IN ('queued','provisioning','running','waiting_approval','cancelling') LIMIT 1",
        )
      )
        throw new HttpError(
          409,
          "Finish or stop the current task before opening OpenCode.",
        );
      this.maintenance = true;
      try {
        let sessionId = thread.runner_session_id;
        {
          const created = await transport.fetch("/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              systemPrompt: this.botInstructions(thread),
              title: thread.title,
              model: thread.model,
              agent: thread.agent,
            }),
          });
          if (!created.ok)
            return new Response(created.body, {
              status: created.status,
              headers: { "content-type": "application/json" },
            });
          sessionId = ((await created.json()) as any).sessionId;
          if (!sessionId)
            throw new HttpError(502, "OpenCode did not return a session");
          this.state.storage.sql.exec(
            "UPDATE threads SET runner_session_id=? WHERE id=?",
            sessionId,
            thread.id,
          );
        }
        const attached = await transport.fetch("/terminal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        return new Response(attached.body, {
          status: attached.status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      } finally {
        this.maintenance = false;
      }
    }
    transport ??= await this.transport();
    if (!["GET", "POST", "DELETE"].includes(request.method))
      throw new HttpError(405, "method not allowed");
    const result = await transport.fetch(
      `${url.pathname.replace(/^\/api/, "")}${url.search}`,
      {
        method: request.method,
        ...(payload
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }
          : {}),
      },
    );
    return new Response(result.body, {
      status: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
  private async providerProxy(request: Request, url: URL): Promise<Response> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    const path = url.pathname.slice(4);
    const allowed =
      (request.method === "GET" && path === "/providers") ||
      (request.method === "POST" &&
        /^\/providers\/(key|custom|credentials\/(activate|label|remove)|oauth\/(start|status|complete|cancel)|command\/(start|status|cancel))$/.test(
          path,
        ));
    if (!allowed) throw new HttpError(404, "Provider operation not found");
    const input =
      request.method === "POST" ? await body<any>(request) : undefined;
    const transport = await this.transport();
    const result = await transport.fetch(path, {
      method: request.method,
      ...(input
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    });
    return new Response(result.body, {
      status: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
  private async catalog(): Promise<Response> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    const transport = await this.transport();
    const result = await transport.fetch("/catalog");
    return new Response(result.body, {
      status: result.status,
      headers: {
        "content-type":
          result.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }
  private async preview(request: Request): Promise<Response> {
    if (this.maintenance)
      throw new HttpError(409, "computer maintenance is in progress");
    const transport = await this.transport();
    const result = await transport.fetch(
      `/preview${new URL(request.url).search}`,
      { method: "GET" },
    );
    const headers = new Headers();
    for (const key of ["content-type", "cache-control", "content-length"]) {
      const value = result.headers.get(key);
      if (value) headers.set(key, value);
    }
    return new Response(result.body, { status: result.status, headers });
  }
  private async computerSpec() {
    const runnerEnv = Object.fromEntries(
      [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "XAI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENCODE_API_KEY",
      ]
        .map((key) => [key, (this.env as any)[key]])
        .filter(([, value]) => value),
    );
    return {
      computerId: "shared",
      runnerToken: this.env.RUNNER_TOKEN!,
      generation: await this.computerGeneration(),
      runnerEnv,
    };
  }
  private async transport() {
    const readiness = await this.computerManager().prepare(
      await this.computerSpec(),
    );
    if (readiness.state !== "ready")
      throw new HttpError(
        409,
        `Computer recovery required (${readiness.state}). Restore the last checkpoint in Computer & checkpoints.`,
      );
    return readiness.handle.transport;
  }
  private ownedRunnerInput(run: any, thread: any): Record<string, unknown> {
    return {
      runId: run.id,
      threadId: run.thread_id,
      prompt: run.prompt,
      ...(run.attachments ? { attachments: parseJson(run.attachments, []) } : {}),
      ...(run.command_name
        ? { command: { name: run.command_name, text: run.command_text ?? "" } }
        : {}),
      ...(run.session_action
        ? {
            sessionAction: {
              name: run.session_action,
              input: parseJson(run.session_action_input, {}),
            },
          }
        : {}),
      sessionId: thread.prior_session_id ?? undefined,
      model: thread.model,
      agent: thread.agent || undefined,
      systemPrompt: this.botInstructions(thread),
      title: thread.title,
      directory: "/workspace/shared",
      botDirectory: this.botDirectory(thread.bot_id),
      delegationHistory: this.delegations(thread.id),
      allowBotMessaging: Number(run.bot_messaging ?? 1) !== 0,
    };
  }
  private async dispatchOwned(run: any, nodeId: string): Promise<void> {
    const claimed = this.state.storage.sql.exec(
      "UPDATE runs SET status='provisioning', dispatch_attempts=dispatch_attempts+1, updated_at=? WHERE id=? AND status='queued'",
      isoNow(),
      run.id,
    );
    if (!claimed.rowsWritten) return;
    const thread = this.one<any>(
      "SELECT t.*, b.instructions, b.model, b.agent, COALESCE(t.runner_session_id, (SELECT runner_session_id FROM runs WHERE thread_id=t.id AND runner_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1)) AS prior_session_id FROM threads t JOIN bots b ON b.id=t.bot_id WHERE t.id=?",
      run.thread_id,
    );
    if (!thread || thread.node_id !== nodeId) {
      this.transition(run.id, "provisioning", "needs_review", {
        reason: "owned node affinity changed or thread disappeared",
      });
      return;
    }
    this.event(run.id, "node.dispatching", {
      nodeId,
      attempt: Number(run.dispatch_attempts ?? 0) + 1,
    });
    try {
      const job = await this.nodes().enqueue(
        nodeId,
        { kind: "runner.run", run: this.ownedRunnerInput(run, thread) },
        50,
      );
      this.state.storage.sql.exec(
        "UPDATE runs SET node_job_id=?,updated_at=? WHERE id=?",
        job.id,
        isoNow(),
        run.id,
      );
      this.transition(run.id, "provisioning", "running", {
        nodeId,
        nodeJobId: job.id,
        accepted: true,
      });
    } catch (error) {
      this.transition(run.id, "provisioning", "needs_review", {
        nodeId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async enqueueOwnedCommand(
    run: any,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const thread = this.one<any>(
      "SELECT node_id FROM threads WHERE id=?",
      run.thread_id,
    );
    if (!thread?.node_id)
      throw new HttpError(409, "run is not assigned to an owned node");
    const command = await this.nodes().enqueue(thread.node_id, payload, 100);
    this.state.storage.sql.exec(
      "UPDATE runs SET node_command_job_id=?,updated_at=? WHERE id=?",
      command.id,
      isoNow(),
      run.id,
    );
    this.event(run.id, "node.command_queued", {
      nodeId: thread.node_id,
      nodeCommandJobId: command.id,
      kind: payload.kind,
    });
  }
  private async reconcileOwnedNode(run: any, nodeId: string): Promise<void> {
    if (run.status === "queued") {
      await this.dispatchOwned(run, nodeId);
      return;
    }
    if (!run.node_job_id) {
      if (canTransition(run.status, "needs_review"))
        this.transition(run.id, run.status, "needs_review", {
          reason: "owned node run has no durable job receipt",
        });
      return;
    }
    if (run.node_command_job_id) {
      const command = this.nodes().getJob(run.node_command_job_id);
      if (!command) {
        if (canTransition(run.status, "needs_review"))
          this.transition(run.id, run.status, "needs_review", {
            reason: "owned node command receipt disappeared; refusing replay",
          });
        return;
      }
      if (command.status === "failed" || command.status === "needs_review") {
        if (canTransition(run.status, "needs_review"))
          this.transition(run.id, run.status, "needs_review", {
            nodeId,
            nodeCommandJobId: command.id,
            reason: command.error ?? "owned node command failed",
          });
        return;
      }
      if (command.status !== "succeeded") return;
      const commandResult =
        command.result && typeof command.result === "object"
          ? (command.result as any)
          : {};
      this.state.storage.sql.exec(
        "UPDATE runs SET node_command_job_id=NULL,updated_at=? WHERE id=?",
        isoNow(),
        run.id,
      );
      const current =
        this.one<any>("SELECT * FROM runs WHERE id=?", run.id) ?? run;
      if (
        command.payload.kind === "runner.cancel" &&
        canTransition(current.status, "cancelled")
      ) {
        this.transition(run.id, current.status, "cancelled", {
          source: "owned-node",
          nodeCommandJobId: command.id,
        });
        return;
      }
      if (
        command.payload.kind === "runner.approval" &&
        current.status === "waiting_approval"
      ) {
        if (commandResult.status === "running")
          this.transition(run.id, current.status, "running", {
            source: "owned-node",
            nodeCommandJobId: command.id,
          });
        else if (
          commandResult.status === "cancelled" &&
          canTransition(current.status, "needs_review")
        )
          this.transition(run.id, current.status, "needs_review", {
            source: "owned-node",
            reason: "runner rejected approval",
          });
        return;
      }
      if (command.payload.kind === "runner.approval") return;
    }
    const job = this.nodes().getJob(run.node_job_id);
    if (!job) {
      if (canTransition(run.status, "needs_review"))
        this.transition(run.id, run.status, "needs_review", {
          reason: "owned node job receipt disappeared; refusing replay",
        });
      return;
    }
    if (
      job.status === "leased" &&
      job.result &&
      typeof job.result === "object" &&
      typeof (job.result as any).status === "string"
    ) {
      await this.reconcile(run, job.result);
    }
    if (job.status === "failed" || job.status === "needs_review") {
      if (canTransition(run.status, "needs_review"))
        this.transition(run.id, run.status, "needs_review", {
          nodeId,
          nodeJobId: job.id,
          reason: job.error ?? "owned node job failed",
        });
      return;
    }
    if (job.status !== "succeeded") return;
    const result =
      job.result && typeof job.result === "object" ? job.result : null;
    if (!result || typeof (result as any).status !== "string") {
      if (canTransition(run.status, "needs_review"))
        this.transition(run.id, run.status, "needs_review", {
          nodeId,
          nodeJobId: job.id,
          reason: "owned node returned no runner receipt",
        });
      return;
    }
    await this.reconcile(run, result);
  }
  private async runner(
    run: any,
  ): Promise<{ status: "missing" | "found"; value?: any }> {
    const transport = await this.transport();
    const result = await transport.fetch(`/runs/${encodeURIComponent(run.id)}`);
    if (result.status === 404) return { status: "missing" };
    if (!result.ok) throw new Error(`runner status HTTP ${result.status}`);
    return { status: "found", value: await result.json() };
  }
  private async reconcileDelegationRequests(run: any, remote: any): Promise<void> {
    if (Number(run.bot_messaging ?? 1) === 0 || remote.status !== "succeeded") return;
    const requests = Array.isArray(remote.delegationRequests)
      ? remote.delegationRequests.slice(0, 8)
      : [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index] && typeof requests[index] === "object" ? requests[index] : {};
      const requestId = typeof request.id === "string" && request.id.trim()
        ? request.id.trim().slice(0, 160)
        : `invalid-${index}`;
      if (this.one("SELECT request_id FROM delegation_requests WHERE run_id=? AND request_id=?", run.id, requestId)) continue;
      const now = isoNow();
      this.state.storage.sql.exec(
        "INSERT INTO delegation_requests (run_id,request_id,status,created_at,updated_at) VALUES (?,?,?,?,?)",
        run.id, requestId, "pending", now, now,
      );
      try {
        if (requestId.startsWith("invalid-") || typeof request.targetBotId !== "string" || typeof request.prompt !== "string")
          throw new HttpError(400, "delegation request requires id, targetBotId, and prompt");
        const delegation = this.createDelegation(run.thread_id, {
          targetBotId: request.targetBotId,
          prompt: request.prompt,
          idempotencyKey: `tool:${run.id}:${requestId}`,
          sourceRunId: run.id,
        });
        this.state.storage.sql.exec(
          "UPDATE delegation_requests SET status='accepted',delegation_id=?,updated_at=? WHERE run_id=? AND request_id=?",
          delegation.id, isoNow(), run.id, requestId,
        );
        this.event(run.id, "delegation.queued", { requestId, delegationId: delegation.id, targetBotId: request.targetBotId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.storage.sql.exec(
          "UPDATE delegation_requests SET status='rejected',error=?,updated_at=? WHERE run_id=? AND request_id=?",
          message, isoNow(), run.id, requestId,
        );
        this.event(run.id, "delegation.rejected", { requestId, error: message });
      }
    }
    await this.maybeContinueAfterDelegations(run.id);
    this.state.storage.setAlarm(Date.now() + 1000);
  }
  private async reconcileBotCreationRequests(run: any, remote: any): Promise<void> {
    if (Number(run.bot_messaging ?? 1) === 0 || remote.status !== "succeeded") return;
    const requests = Array.isArray(remote.botCreationRequests)
      ? remote.botCreationRequests.slice(0, 4)
      : [];
    const created: any[] = [];
    const rejected: string[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index] && typeof requests[index] === "object" ? requests[index] : {};
      const requestId = typeof request.id === "string" && request.id.trim() ? request.id.trim().slice(0, 160) : `invalid-${index}`;
      if (this.one("SELECT request_id FROM bot_creation_requests WHERE run_id=? AND request_id=?", run.id, requestId)) continue;
      const now = isoNow();
      this.state.storage.sql.exec(
        "INSERT INTO bot_creation_requests (run_id,request_id,status,created_at,updated_at) VALUES (?,?,?,?,?)",
        run.id, requestId, "pending", now, now,
      );
      try {
        if (requestId.startsWith("invalid-") || typeof request.name !== "string") throw new HttpError(400, "bot creation requires a name");
        if (this.one("SELECT id FROM bots WHERE lower(name)=lower(?)", request.name.trim())) throw new HttpError(409, "A bot with that name already exists. Choose another name.");
        const parent = this.one<any>("SELECT b.model,b.agent,b.node_id FROM bots b JOIN threads t ON t.bot_id=b.id WHERE t.id=?", run.thread_id);
        const item = this.createBot({
          name: request.name,
          instructions: request.instructions ?? "",
          model: request.model || parent?.model || "",
          agent: request.agent || parent?.agent || "",
          nodeId: parent?.node_id,
        });
        this.state.storage.sql.exec("UPDATE bot_creation_requests SET status='created',bot_id=?,updated_at=? WHERE run_id=? AND request_id=?", item.id, isoNow(), run.id, requestId);
        created.push(item);
        this.event(run.id, "bot.created", { requestId, botId: item.id, name: item.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.storage.sql.exec("UPDATE bot_creation_requests SET status='rejected',error=?,updated_at=? WHERE run_id=? AND request_id=?", message, isoNow(), run.id, requestId);
        rejected.push(message);
        this.event(run.id, "bot.creation.rejected", { requestId, error: message });
      }
    }
    if (!created.length && !rejected.length) return;
    if (this.one("SELECT source_run_id FROM bot_creation_continuations WHERE source_run_id=?", run.id)) return;
    const source = this.one<any>("SELECT * FROM runs WHERE id=?", run.id);
    if (!source || !TERMINAL.has(source.status)) return;
    const summary = created.map((item) => `Created ${item.name} (${item.id}) with its own persisted settings and conversations.`).join("\n");
    const errors = rejected.map((error) => `[Bot creation rejected] ${error}`).join("\n");
    const continuation = this.createRun({
      threadId: source.thread_id,
      prompt: `Continue the original task and tell the user what happened with the requested bot creation.\n\n${summary}${errors ? `\n\n${errors}` : ""}`,
      idempotencyKey: `tool-bot-creation:${run.id}`,
      allowBotMessaging: false,
    });
    this.state.storage.sql.exec("INSERT INTO bot_creation_continuations (source_run_id,continuation_run_id,created_at,updated_at) VALUES (?,?,?,?)", run.id, continuation.id, isoNow(), isoNow());
  }
  private async maybeContinueAfterDelegations(sourceRunId: string): Promise<void> {
    const source = this.one<any>("SELECT * FROM runs WHERE id=?", sourceRunId);
    if (!source || Number(source.bot_messaging ?? 1) === 0 || !TERMINAL.has(source.status)) return;
    const requests = this.rows<any>("SELECT * FROM delegation_requests WHERE run_id=?", sourceRunId);
    const accepted = requests.filter((request) => request.status === "accepted" && request.delegation_id);
    if (!requests.length || accepted.some((request) => !this.one("SELECT id FROM delegations WHERE id=?", request.delegation_id))) return;
    const existing = this.one<any>("SELECT * FROM delegation_continuations WHERE source_run_id=?", sourceRunId);
    if (existing?.status === "created") return;
    if (!existing) {
      const now = isoNow();
      this.state.storage.sql.exec("INSERT INTO delegation_continuations (source_run_id,status,created_at,updated_at) VALUES (?,?,?,?)", sourceRunId, "pending", now, now);
    }
    const unfinished = this.one<any>(
      `SELECT r.status FROM delegation_requests q JOIN delegations d ON d.id=q.delegation_id JOIN runs r ON r.id=d.target_run_id
       WHERE q.run_id=? AND q.status='accepted' AND r.status NOT IN ('succeeded','failed','cancelled','needs_review') LIMIT 1`,
      sourceRunId,
    );
    if (unfinished) return;
    // A delegated bot may itself have queued peer work. Wait for that bot's
    // continuation, so the parent receives its completed answer rather than
    // the intermediate "queued" response.
    for (const request of accepted) {
      const delegation = this.one<any>("SELECT target_run_id FROM delegations WHERE id=?", request.delegation_id);
      if (!delegation) return;
      const continuation = this.one<any>(
        "SELECT dc.status,cr.status AS run_status FROM delegation_continuations dc LEFT JOIN runs cr ON cr.id=dc.continuation_run_id WHERE dc.source_run_id=?",
        delegation.target_run_id,
      );
      if (continuation && (continuation.status !== "created" || !TERMINAL.has(String(continuation.run_status)))) return;
    }
    const active = this.one("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','provisioning','running','waiting_approval','cancelling')", source.thread_id);
    if (active) return;
    const results = this.delegations(source.thread_id)
      .filter((delegation) => accepted.some((request) => request.delegation_id === delegation.id))
      .map((delegation) => `[${delegation.targetBotName}; ${delegation.status}] ${delegation.result ?? delegation.error ?? ""}`)
      .join("\n\n");
    const rejected = requests
      .filter((request) => request.status === "rejected")
      .map((request) => `[Delegation rejected] ${request.error ?? "invalid request"}`)
      .join("\n");
    const continuation = this.createRun({
      threadId: source.thread_id,
      prompt: `Continue the original task using these completed peer results. Summarize what they found and finish the task; do not delegate further in this turn.\n\n${results}${rejected ? `\n\n${rejected}` : ""}`,
      idempotencyKey: `tool-continuation:${sourceRunId}`,
      allowBotMessaging: false,
    });
    // Carry the originating Telegram route onto the internal continuation.
    // Reset delivery state: the source receipt may already have been sent.
    const telegramDelivery = this.one<any>(
      "SELECT bot_id,chat_id,telegram_user_id FROM telegram_run_deliveries WHERE run_id=?",
      sourceRunId,
    );
    if (telegramDelivery)
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO telegram_run_deliveries (run_id,bot_id,chat_id,telegram_user_id,created_at,status) VALUES (?,?,?,?,?,?)",
        continuation.id,
        telegramDelivery.bot_id,
        telegramDelivery.chat_id,
        telegramDelivery.telegram_user_id,
        isoNow(),
        "pending",
      );
    if(telegramDelivery) await this.telegram().inheritRunProgress(sourceRunId, continuation.id);
    this.state.storage.sql.exec("UPDATE delegation_continuations SET status='created',continuation_run_id=?,updated_at=? WHERE source_run_id=?", continuation.id, isoNow(), sourceRunId);
  }
  private async advancePendingContinuations(): Promise<void> {
    for (const row of this.rows<any>("SELECT source_run_id FROM delegation_continuations WHERE status='pending' LIMIT 8"))
      await this.maybeContinueAfterDelegations(row.source_run_id);
  }
  private async dispatch(run: any): Promise<void> {
    const now = isoNow();
    const claimed = this.state.storage.sql.exec(
      "UPDATE runs SET status='provisioning', dispatch_attempts=dispatch_attempts+1, updated_at=? WHERE id=? AND status='queued'",
      now,
      run.id,
    );
    if (!claimed.rowsWritten) return;
    const thread = this.one<any>(
      "SELECT t.*, b.instructions, b.model, b.agent, COALESCE(t.runner_session_id, (SELECT runner_session_id FROM runs WHERE thread_id=t.id AND runner_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1)) AS prior_session_id FROM threads t JOIN bots b ON b.id=t.bot_id WHERE t.id=?",
      run.thread_id,
    );
    if (!thread) {
      this.transition(run.id, "provisioning", "failed", {
        error: "thread disappeared",
      });
      return;
    }
    this.event(run.id, "run.dispatching", {
      attempt: run.dispatch_attempts + 1,
    });
    const systemPrompt = this.botInstructions(thread);
    const transport = await this.transport();
    const result = await transport.fetch("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: run.id,
        threadId: run.thread_id,
        prompt: run.prompt,
        ...(run.command_name
          ? {
              command: { name: run.command_name, text: run.command_text ?? "" },
            }
          : {}),
        ...(run.session_action
          ? {
              sessionAction: {
                name: run.session_action,
                input: parseJson(run.session_action_input, {}),
              },
            }
          : {}),
        sessionId: thread.prior_session_id ?? undefined,
        model: thread.model,
        agent: thread.agent || undefined,
        systemPrompt,
        title: thread.title,
        directory: "/workspace/shared",
        botDirectory: this.botDirectory(thread.bot_id),
        delegationHistory: this.delegations(thread.id),
        allowBotMessaging: Number(run.bot_messaging ?? 1) !== 0,
      }),
    });
    if (!result.ok) {
      const current = this.one<any>(
        "SELECT status FROM runs WHERE id=?",
        run.id,
      );
      if (current?.status === "provisioning")
        this.transition(run.id, current.status, "needs_review", {
          reason: `runner dispatch HTTP ${result.status}`,
        });
      return;
    }
    const current = this.one<any>("SELECT status FROM runs WHERE id=?", run.id);
    if (current?.status === "provisioning")
      this.transition(run.id, current.status, "running", { accepted: true });
    else if (current?.status === "cancelling") {
      try {
        const active = await this.transport();
        await active.fetch(`/runs/${run.id}/cancel`, { method: "POST" });
      } catch (error) {
        this.event(run.id, "cancel.forward_error", { error: String(error) });
      }
    }
  }
  private async reconcile(run: any, remote: any): Promise<void> {
    if (remote.sessionId) {
      this.state.storage.sql.exec(
        "UPDATE runs SET runner_session_id=?, updated_at=? WHERE id=?",
        remote.sessionId,
        isoNow(),
        run.id,
      );
      this.state.storage.sql.exec(
        "UPDATE threads SET runner_session_id=?, updated_at=? WHERE id=?",
        remote.sessionId,
        isoNow(),
        run.thread_id,
      );
    }
    for (const item of Array.isArray(remote.events) ? remote.events : []) {
      const seq = Number(item.seq ?? 0);
      if (seq <= Number(run.runner_sequence ?? 0)) continue;
      const payload = item.data ?? item;
      this.event(run.id, `runner.${item.type ?? "event"}`, payload);
      const approvalId =
        item.data?.requestId ??
        item.data?.properties?.permissionID ??
        item.data?.properties?.requestID ??
        item.data?.properties?.id;
      if (
        String(item.type).includes("approval") ||
        String(item.type).includes("permission")
      ) {
        if (approvalId)
          this.state.storage.sql.exec(
            "INSERT OR IGNORE INTO approvals (request_id,run_id,decision,payload,created_at,updated_at) VALUES (?,?,NULL,?,?,?)",
            String(approvalId),
            run.id,
            json(payload),
            isoNow(),
            isoNow(),
          );
      }
      this.state.storage.sql.exec(
        "UPDATE runs SET runner_sequence=?,updated_at=? WHERE id=?",
        seq,
        isoNow(),
        run.id,
      );
      run.runner_sequence = seq;
    }
    const current =
      this.one<any>("SELECT * FROM runs WHERE id=?", run.id) ?? run;
    const remoteStatus = remote.status as RunStatus;
    if (remoteStatus === "succeeded" && !TERMINAL.has(current.status)) {
      this.transition(run.id, current.status, "succeeded", {
        source: "runner",
      });
      this.state.storage.sql.exec(
        "UPDATE runs SET result=? WHERE id=?",
        remote.final ?? null,
        run.id,
      );
    } else if (remoteStatus === "failed" && !TERMINAL.has(current.status)) {
      this.transition(run.id, current.status, "failed", { source: "runner" });
      this.state.storage.sql.exec(
        "UPDATE runs SET error=? WHERE id=?",
        String(
          remote.error ?? "OpenCode execution failed; see the activity log.",
        ),
        run.id,
      );
    } else if (remoteStatus === "needs_review" && !TERMINAL.has(current.status))
      this.transition(run.id, current.status, "needs_review", {
        source: "runner",
        reason:
          "Runner could not establish a safe terminal receipt. Work has not been replayed.",
      });
    else if (remoteStatus === "cancelled" && !TERMINAL.has(current.status))
      this.transition(run.id, current.status, "cancelled", {
        source: "runner",
      });
    else if (
      remoteStatus === "waiting_approval" &&
      current.status === "running"
    )
      this.transition(run.id, current.status, "waiting_approval", {
        source: "runner",
      });
    else if (
      current.status === "cancelling" &&
      ["running", "provisioning", "waiting_approval"].includes(remoteStatus)
    ) {
      try {
        const transport = await this.transport();
        const result = await transport.fetch(`/runs/${run.id}/cancel`, { method: "POST" });
        if (!result.ok) throw new Error(`runner cancel HTTP ${result.status}`);
      } catch (error) {
        this.event(run.id, "cancel.forward_error", { error: String(error) });
      }
    }
    await this.reconcileDelegationRequests(run, remote);
    await this.reconcileBotCreationRequests(run, remote);
  }
}

const TERMINAL = new Set(["succeeded", "failed", "needs_review", "cancelled"]);

const CLIENT_MCP_TOOLS = new Set([
  "bot_list", "bot_create", "bot_update", "bot_delete", "thread_list", "thread_create", "thread_update", "thread_delete", "thread_messages",
  "run_list", "run_start", "run_get", "run_events", "run_cancel", "run_approve", "delegation_list", "delegation_create",
  "skill_list", "skill_create", "skill_update", "skill_delete", "file_list", "file_read", "file_write", "upload_file", "attachment_read",
  "computer_readiness", "computer_status", "pairing_session", "routine_list", "routine_create", "routine_update", "routine_delete",
  "memory_list", "memory_add", "memory_delete", "catalog_get", "thread_bot_skills", "thread_assign_skills", "thread_action",
]);

function clientRouteAllowed(request: Request, url: URL): boolean {
  if ((url.pathname === "/api/pairing/session" || url.pathname === "/api/pairing/session/me") && request.method === "GET") return true;
  if (url.pathname === "/api/state" && request.method === "GET") return true;
  if (/^\/api\/bots\/[^/]+\/telegram(?:\/|$)/.test(url.pathname)) return false;
  if (/^\/api\/(bots|threads|runs|routines)(?:\/|$)/.test(url.pathname) || url.pathname === "/api/bots" || url.pathname === "/api/threads" || url.pathname === "/api/runs" || url.pathname === "/api/routines") return true;
  if (/^\/api\/(files|catalog)(?:\/|$)/.test(url.pathname)) return true;
  if (/^\/api\/uploads(?:\/|$)/.test(url.pathname)) return true;
  if (/^\/api\/computer\/(readiness|status|preview)$/.test(url.pathname)) return true;
  if (/^\/api\/terminal(?:\/|$)/.test(url.pathname)) return true;
  // Trusted clients can manage workspace skills; installation/admin routes remain owner-only.
  if (url.pathname === "/api/skills" || /^\/api\/skills\//.test(url.pathname)) return true;
  if (/^\/api\/mcp(?:\/|$)/.test(url.pathname)) return true;
  return false;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/internal/")
    )
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response("control worker", { status: 404 });
    const credential = bearer(request);
    const ownerAuthorized = url.pathname.startsWith("/internal/")
      ? Boolean(
          env.RUNNER_TOKEN &&
          credential &&
          safeEqual(credential, env.RUNNER_TOKEN),
        )
      : Boolean(
          env.APP_TOKEN && credential && safeEqual(credential, env.APP_TOKEN),
        );
    const pairingPublic = url.pathname === "/api/pairing/redeem" && request.method === "POST";
    const pairingClient = url.pathname === "/api/pairing/session" || url.pathname === "/api/pairing/session/me" || clientRouteAllowed(request, url);
    const alternateAuth =
      url.pathname === "/api/nodes" ||
      url.pathname.startsWith("/api/nodes/") ||
      /^\/api\/integrations\/telegram\/webhook\/[^/]+$/.test(url.pathname);
    if (!ownerAuthorized && !alternateAuth && !pairingPublic && !pairingClient)
      return response({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    const idObject = env.WORKSPACE.idFromName("owner");
    return env.WORKSPACE.get(idObject).fetch(request);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const idObject = env.WORKSPACE.idFromName("owner");
    await env.WORKSPACE.get(idObject).fetch(
      new Request("https://workspace/internal/sweep", { method: "POST", headers: env.RUNNER_TOKEN ? { Authorization: `Bearer ${env.RUNNER_TOKEN}` } : undefined }),
    );
  },
};

export default worker;
