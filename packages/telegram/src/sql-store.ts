import type {
  TelegramBotConfig,
  TelegramChatBinding,
  TelegramPairingChallenge,
  TelegramRunDelivery,
  TelegramStore,
} from "./index";

/** Small structural type matching Cloudflare DurableObject storage.sql. */
export type SqlStorage = {
  exec(query: string, ...args: unknown[]): {
    toArray(): Record<string, unknown>[];
    rowsWritten?: number;
  };
};

/**
 * Durable Object SQLite adapter. All writes use parameter binding; tokens are
 * never interpolated into SQL and are only returned to TelegramService for an
 * outbound Bot API request.
 */
export class DurableObjectTelegramStore implements TelegramStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_bot_configs (
      bot_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      telegram_bot_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'webhook',
      first_name TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    try { this.sql.exec("ALTER TABLE telegram_bot_configs ADD COLUMN transport TEXT NOT NULL DEFAULT 'webhook'"); } catch { /* already exists */ }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_pairing_challenges (
      token_digest TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      owner_user_id TEXT,
      thread_id TEXT,
      expected_telegram_user_id TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_chat_bindings (
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      telegram_user_id TEXT NOT NULL,
      owner_user_id TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, chat_id, telegram_user_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_processed_updates (
      bot_id TEXT NOT NULL,
      update_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (bot_id, update_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_run_deliveries (
      run_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      telegram_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    )`);
    // Existing installations created before delivery state was introduced.
    try { this.sql.exec("ALTER TABLE telegram_run_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"); } catch { /* already exists */ }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_poll_offsets (
      bot_id TEXT PRIMARY KEY,
      offset INTEGER NOT NULL
    )`);
  }

  async getBotConfig(botId: string): Promise<TelegramBotConfig | null> {
    const row = this.one<any>("SELECT * FROM telegram_bot_configs WHERE bot_id=?", botId);
    return row ? {
      botId: row.bot_id,
      token: row.token,
      telegramBotId: Number(row.telegram_bot_id),
      username: row.username,
      firstName: row.first_name,
      transport: row.transport === "polling" ? "polling" : "webhook",
      webhookUrl: row.webhook_url || undefined,
      webhookSecret: row.webhook_secret,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async putBotConfig(config: TelegramBotConfig): Promise<void> {
    this.sql.exec(`INSERT INTO telegram_bot_configs
      (bot_id,token,telegram_bot_id,username,transport,first_name,webhook_url,webhook_secret,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(bot_id) DO UPDATE SET token=excluded.token,telegram_bot_id=excluded.telegram_bot_id,
      username=excluded.username,transport=excluded.transport,first_name=excluded.first_name,webhook_url=excluded.webhook_url,
      webhook_secret=excluded.webhook_secret,updated_at=excluded.updated_at`,
      config.botId, config.token, config.telegramBotId, config.username, config.transport, config.firstName,
      config.webhookUrl ?? "", config.webhookSecret, config.createdAt, config.updatedAt);
  }

  async createPairingChallenge(challenge: TelegramPairingChallenge): Promise<void> {
    this.sql.exec(`INSERT INTO telegram_pairing_challenges
      (token_digest,bot_id,owner_user_id,thread_id,expected_telegram_user_id,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?)`, challenge.tokenDigest, challenge.botId, challenge.ownerUserId ?? null,
      challenge.threadId ?? null, challenge.expectedTelegramUserId ?? null, challenge.expiresAt, challenge.createdAt);
  }

  async consumePairingChallenge(tokenDigest: string, now: number): Promise<TelegramPairingChallenge | null> {
    // SQLite's RETURNING makes consumption one atomic operation. The nonce is
    // deleted even when expired, preventing an unbounded challenge table.
    const rows = this.sql.exec(`DELETE FROM telegram_pairing_challenges
      WHERE token_digest=? AND expires_at>? RETURNING *`, tokenDigest, now).toArray();
    const row = rows[0] as any;
    return row ? {
      tokenDigest: row.token_digest,
      botId: row.bot_id,
      ownerUserId: row.owner_user_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      expectedTelegramUserId: row.expected_telegram_user_id ?? undefined,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
    } : null;
  }

  async getChatBinding(botId: string, chatId: string, telegramUserId: string): Promise<TelegramChatBinding | null> {
    const row = this.one<any>(`SELECT * FROM telegram_chat_bindings WHERE bot_id=? AND chat_id=? AND telegram_user_id=?`, botId, chatId, telegramUserId);
    return row ? this.binding(row) : null;
  }

  async putChatBinding(binding: TelegramChatBinding): Promise<void> {
    this.sql.exec(`INSERT INTO telegram_chat_bindings
      (bot_id,chat_id,telegram_user_id,owner_user_id,thread_id,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(bot_id,chat_id,telegram_user_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
      thread_id=excluded.thread_id,created_at=excluded.created_at`, binding.botId, binding.chatId,
      binding.telegramUserId, binding.ownerUserId ?? null, binding.threadId ?? null, binding.createdAt);
  }

  async listChatBindings(botId: string): Promise<TelegramChatBinding[]> {
    return this.sql.exec("SELECT * FROM telegram_chat_bindings WHERE bot_id=? ORDER BY created_at", botId)
      .toArray().map((row) => this.binding(row));
  }

  async deleteChatBinding(botId: string, chatId: string, telegramUserId: string): Promise<boolean> {
    const result = this.sql.exec("DELETE FROM telegram_chat_bindings WHERE bot_id=? AND chat_id=? AND telegram_user_id=?", botId, chatId, telegramUserId);
    return Number(result.rowsWritten ?? 0) > 0;
  }

  async claimUpdate(botId: string, updateId: number): Promise<boolean> {
    const result = this.sql.exec("INSERT OR IGNORE INTO telegram_processed_updates (bot_id,update_id,created_at) VALUES (?,?,?)", botId, updateId, Date.now());
    return Number(result.rowsWritten ?? 0) > 0;
  }

  async releaseUpdate(botId: string, updateId: number): Promise<void> {
    this.sql.exec("DELETE FROM telegram_processed_updates WHERE bot_id=? AND update_id=?", botId, updateId);
  }

  async putRunDelivery(delivery: TelegramRunDelivery): Promise<void> {
    this.sql.exec(`INSERT INTO telegram_run_deliveries (run_id,bot_id,chat_id,telegram_user_id,created_at,status)
      VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET bot_id=excluded.bot_id,chat_id=excluded.chat_id,
      telegram_user_id=excluded.telegram_user_id,created_at=excluded.created_at`, delivery.runId, delivery.botId,
      delivery.chatId, delivery.telegramUserId, delivery.createdAt, delivery.status ?? "pending");
  }

  async getRunDelivery(runId: string): Promise<TelegramRunDelivery | null> {
    const row = this.one<any>("SELECT * FROM telegram_run_deliveries WHERE run_id=?", runId);
    return row ? {
      runId: row.run_id,
      botId: row.bot_id,
      chatId: row.chat_id,
      telegramUserId: row.telegram_user_id,
      createdAt: row.created_at,
      status: row.status ?? "pending",
    } : null;
  }

  async getPollingOffset(botId: string): Promise<number | null> {
    const row = this.one<any>("SELECT offset FROM telegram_poll_offsets WHERE bot_id=?", botId);
    return row ? Number(row.offset) : null;
  }

  async setPollingOffset(botId: string, offset: number): Promise<void> {
    this.sql.exec("INSERT INTO telegram_poll_offsets (bot_id,offset) VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET offset=excluded.offset", botId, offset);
  }

  async claimRunDelivery(runId: string): Promise<TelegramRunDelivery | null> {
    // A process that died after sendMessage and before marking sent leaves
    // `sending`; that state is intentionally promoted to needs_review instead
    // of silently sending a duplicate on the next worker alarm.
    this.sql.exec("UPDATE telegram_run_deliveries SET status='needs_review' WHERE run_id=? AND status='sending'", runId);
    const rows = this.sql.exec("UPDATE telegram_run_deliveries SET status='sending' WHERE run_id=? AND status='pending' RETURNING *", runId).toArray();
    const row = rows[0] as any;
    return row ? {
      runId: row.run_id,
      botId: row.bot_id,
      chatId: row.chat_id,
      telegramUserId: row.telegram_user_id,
      createdAt: row.created_at,
      status: "sending",
    } : null;
  }

  async markRunDeliverySent(runId: string): Promise<void> {
    this.sql.exec("UPDATE telegram_run_deliveries SET status='sent' WHERE run_id=? AND status='sending'", runId);
  }

  async markRunDeliveryNeedsReview(runId: string): Promise<void> {
    this.sql.exec("UPDATE telegram_run_deliveries SET status='needs_review' WHERE run_id=? AND status='sending'", runId);
  }

  private one<T = Record<string, unknown>>(query: string, ...args: unknown[]): T | undefined {
    return this.sql.exec(query, ...args).toArray()[0] as T | undefined;
  }

  private binding(row: any): TelegramChatBinding {
    return {
      botId: row.bot_id,
      chatId: row.chat_id,
      telegramUserId: row.telegram_user_id,
      ownerUserId: row.owner_user_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      createdAt: row.created_at,
    };
  }
}
