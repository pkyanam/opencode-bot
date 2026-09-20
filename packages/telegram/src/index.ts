/**
 * Telegram Bot API integration.
 *
 * The package deliberately has no knowledge of the control worker's database.
 * Store is the persistence boundary: the worker can back it with Durable Object
 * SQL while tests and local development can use InMemoryTelegramStore.
 */

export type TelegramBotIdentity = {
  id: number;
  is_bot: true;
  first_name: string;
  username?: string;
};

export type TelegramBotConfig = {
  botId: string;
  /** Secret. Never include this object in a response or log. */
  token: string;
  telegramBotId: number;
  username: string;
  firstName: string;
  transport: "webhook" | "polling";
  webhookUrl?: string;
  webhookSecret: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramPublicBotConfig = Omit<
  TelegramBotConfig,
  "token" | "webhookSecret"
>;

export type TelegramPairingChallenge = {
  tokenDigest: string;
  botId: string;
  ownerUserId?: string;
  threadId?: string;
  expectedTelegramUserId?: string;
  expiresAt: number;
  createdAt: number;
};

export type TelegramChatBinding = {
  botId: string;
  ownerUserId?: string;
  threadId?: string;
  telegramUserId: string;
  chatId: string;
  createdAt: string;
};

export type TelegramRunDelivery = {
  runId: string;
  botId: string;
  chatId: string;
  telegramUserId: string;
  createdAt: string;
  /** Delivery is one-shot. `sending` is treated as uncertain after a restart. */
  status?: "pending" | "sending" | "sent" | "needs_review";
};

/** Persistence operations required by TelegramService. Implement atomically in production. */
export interface TelegramStore {
  getBotConfig(botId: string): Promise<TelegramBotConfig | null>;
  putBotConfig(config: TelegramBotConfig): Promise<void>;
  createPairingChallenge(challenge: TelegramPairingChallenge): Promise<void>;
  /** Return and consume a challenge only when it exists and is not expired. */
  consumePairingChallenge(
    tokenDigest: string,
    now: number,
  ): Promise<TelegramPairingChallenge | null>;
  getChatBinding(
    botId: string,
    chatId: string,
    telegramUserId: string,
  ): Promise<TelegramChatBinding | null>;
  putChatBinding(binding: TelegramChatBinding): Promise<void>;
  listChatBindings(botId: string): Promise<TelegramChatBinding[]>;
  deleteChatBinding(botId: string, chatId: string, telegramUserId: string): Promise<boolean>;
  /** Atomically claims update_id for this bot. */
  claimUpdate(botId: string, updateId: number): Promise<boolean>;
  releaseUpdate?(botId: string, updateId: number): Promise<void>;
  putRunDelivery(delivery: TelegramRunDelivery): Promise<void>;
  getRunDelivery(runId: string): Promise<TelegramRunDelivery | null>;
  /** Atomic claim. A claim left in `sending` is converted to needs_review after restart. */
  claimRunDelivery?(runId: string): Promise<TelegramRunDelivery | null>;
  markRunDeliverySent?(runId: string): Promise<void>;
  markRunDeliveryNeedsReview?(runId: string): Promise<void>;
  getPollingOffset?(botId: string): Promise<number | null>;
  setPollingOffset?(botId: string, offset: number): Promise<void>;
}

export type TelegramApi = {
  getMe(token: string): Promise<TelegramBotIdentity>;
  setWebhook(
    token: string,
    input: { url: string; secretToken: string; allowedUpdates?: string[] },
  ): Promise<void>;
  deleteWebhook?(token: string): Promise<void>;
  getUpdates?(token: string, input: {
    offset?: number;
    timeout: number;
    allowedUpdates?: string[];
  }): Promise<TelegramUpdate[]>;
  setMyCommands?(token: string, commands: TelegramCommand[]): Promise<void>;
  sendMessage(
    token: string,
    input: { chatId: string; text: string },
  ): Promise<{ messageId?: number }>;
};

export type TelegramPairingLink = {
  botId: string;
  deepLink: string;
  expiresAt: string;
};

export type TelegramMessageContext = {
  botId: string;
  ownerUserId?: string;
  threadId?: string;
  telegramUserId: string;
  chatId: string;
  text: string;
  messageId?: number;
  updateId: number;
  /** Stable key for the control worker's idempotencyKey field. */
  idempotencyKey: string;
  update: TelegramUpdate;
};

export type TelegramMessageRouteResult = { runId?: string } | void;

export type TelegramCommand = { command: string; description: string };

export type TelegramCommandContext = {
  botId: string;
  ownerUserId?: string;
  threadId?: string;
  telegramUserId: string;
  chatId: string;
  commandName: string;
  commandText: string;
  messageId?: number;
  updateId: number;
  idempotencyKey: string;
  update: TelegramUpdate;
};

export type TelegramCommandRouteResult = {
  text?: string;
  runId?: string;
  threadId?: string;
} | void;

export type TelegramServiceOptions = {
  store: TelegramStore;
  api?: TelegramApi;
  now?: () => number;
  /** Called after a validated, paired message. It should enqueue one control-worker run. */
  onMessage?: (
    message: TelegramMessageContext,
  ) => Promise<TelegramMessageRouteResult>;
  /** Routes paired slash commands, including /new and native catalog commands. */
  onCommand?: (command: TelegramCommandContext) => Promise<TelegramCommandRouteResult>;
  /** Resolves authenticated native commands for the configured bot. */
  commandsForBot?: (botId: string) => Promise<TelegramCommand[]>;
  /** Called after a pairing link is consumed. */
  onPaired?: (binding: TelegramChatBinding) => Promise<void>;
  /** Bot API base URL, useful for tests or a controlled egress proxy. */
  apiBaseUrl?: string;
  /** Polling timeout is intentionally short for Durable Object alarms. */
  pollTimeoutSeconds?: number;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    from?: { id: number; is_bot?: boolean; username?: string };
    chat?: { id: number | string; type?: string; title?: string };
    text?: string;
  };
  [key: string]: unknown;
};

export type TelegramWebhookOutcome = {
  status: 200 | 400 | 401 | 404 | 413 | 500;
  accepted: boolean;
  duplicate?: boolean;
  paired?: boolean;
  routed?: boolean;
  runId?: string;
  reason?:
    | "unknown_bot"
    | "invalid_secret"
    | "invalid_json"
    | "invalid_update"
    | "expired_pairing"
    | "unpaired_chat"
    | "empty_message"
    | "handler_error";
};

export type TelegramPollOutcome = {
  polled: boolean;
  updates: number;
  accepted: number;
  offset?: number;
  error?: "not_configured" | "not_polling" | "unsupported" | "conflict" | "api_error";
};

export type RunCompletion = {
  runId: string;
  status: "succeeded" | "failed" | "needs_review" | "cancelled";
  output?: string;
  error?: string;
};

const MAX_WEBHOOK_BODY = 1_000_000;
const MAX_TELEGRAM_MESSAGE = 4096;
const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_COMMANDS: TelegramCommand[] = [
  { command: "new", description: "Start a new conversation" },
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show current run status" },
  { command: "stop", description: "Stop the active run" },
];
const textEncoder = new TextEncoder();

export class TelegramApiError extends Error {
  constructor(public readonly method: string, public readonly status: number) {
    super(`Telegram API ${method} failed (${status})`);
  }
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

function normalizeId(value: number | string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("telegram identifier is out of range");
  const result = String(value);
  if (!/^-?\d+$/.test(result)) throw new Error("telegram identifier is invalid");
  return result;
}

function safeEqual(a: string, b: string): boolean {
  const aa = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const n = Math.max(aa.length, bb.length);
  let difference = aa.length ^ bb.length;
  for (let i = 0; i < n; i++)
    difference |= (aa[i % (aa.length || 1)] ?? 0) ^ (bb[i % (bb.length || 1)] ?? 0);
  return difference === 0;
}

function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  // btoa is available in Workers and modern Node. Avoid Buffer so this package
  // can run in both environments without a node compatibility flag.
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function validateToken(token: string): string {
  const value = token.trim();
  if (value !== token || value.length < 8 || value.length > 4096 || /[\r\n\s]/.test(value))
    throw new Error("Telegram bot token is invalid");
  return value;
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("webhookUrl must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("webhookUrl must be an absolute HTTPS URL");
  if (url.username || url.password || url.hash) throw new Error("webhookUrl contains unsupported URL parts");
  return url.toString();
}

function validateSecret(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error("webhook secret is invalid");
  return value;
}

function telegramUsername(identity: TelegramBotIdentity): string {
  if (!identity.username || !/^[A-Za-z0-9_]{5,32}$/.test(identity.username))
    throw new Error("Telegram bot did not return a usable username");
  return identity.username;
}

function publicConfig(config: TelegramBotConfig): TelegramPublicBotConfig {
  const { token: _token, webhookSecret: _webhookSecret, webhookUrl, ...publicValue } = config;
  return webhookUrl ? { ...publicValue, webhookUrl } : publicValue;
}

function parseStart(text: string, botUsername: string): string | null {
  const match = text.trim().match(/^\/start(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([^\s]{1,128}))?$/);
  if (!match || (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase())) return null;
  return match[2] ?? null;
}

function splitMessage(text: string): string[] {
  const value = text || "(no output)";
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > MAX_TELEGRAM_MESSAGE) {
    let cut = remaining.slice(0, MAX_TELEGRAM_MESSAGE);
    const newline = cut.lastIndexOf("\n");
    if (newline > MAX_TELEGRAM_MESSAGE * 0.6) cut = cut.slice(0, newline);
    chunks.push(cut);
    remaining = remaining.slice(cut.length);
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, "[redacted]") : text;
}

function normalizeCommands(commands: TelegramCommand[]): TelegramCommand[] {
  const seen = new Set<string>();
  const result: TelegramCommand[] = [];
  for (const item of commands) {
    const command = String(item.command ?? "").replace(/^\//, "").toLowerCase();
    const description = String(item.description ?? "").trim();
    if (!/^[a-z0-9_]{1,32}$/.test(command) || !description || description.length > 256 || seen.has(command)) continue;
    seen.add(command);
    result.push({ command, description });
  }
  return result.slice(0, 100);
}

function parseCommand(text: string, botUsername: string): { name: string; input: string } | null {
  const match = text.trim().match(/^\/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/);
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), input: match[3] ?? "" };
}

/** Minimal default Bot API client. It intentionally never includes a token in errors. */
export function createTelegramApi(fetchImpl: typeof fetch = fetch, baseUrl = "https://api.telegram.org"): TelegramApi {
  const endpoint = baseUrl.replace(/\/$/, "");
  async function call<T>(token: string, method: string, input?: unknown): Promise<T> {
    let response: Response;
    try {
      // `:` is the documented BotFather token separator and is left readable
      // for standard Bot API URLs; any other URL-significant characters remain
      // escaped.
      const pathToken = encodeURIComponent(token).replaceAll("%3A", ":");
      response = await fetchImpl(`${endpoint}/bot${pathToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
    } catch {
      // Do not propagate a fetch implementation's URL-bearing error; the URL
      // contains the BotFather token by design.
      throw new Error(`Telegram API ${method} is unavailable`);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Telegram API ${method} returned an invalid response`);
    }
    if (!response.ok || payload?.ok !== true)
      throw new TelegramApiError(method, Number(payload?.error_code ?? response.status));
    return payload.result as T;
  }
  return {
    async getMe(token) {
      const result = await call<TelegramBotIdentity>(token, "getMe");
      if (!result || result.is_bot !== true || !Number.isSafeInteger(result.id))
        throw new Error("Telegram getMe returned an invalid bot");
      return result;
    },
    async setWebhook(token, input) {
      await call<boolean>(token, "setWebhook", {
        url: input.url,
        secret_token: input.secretToken,
        allowed_updates: input.allowedUpdates ?? ["message"],
      });
    },
    async deleteWebhook(token) {
      await call<boolean>(token, "deleteWebhook");
    },
    async getUpdates(token, input) {
      const result = await call<TelegramUpdate[]>(token, "getUpdates", {
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        timeout: input.timeout,
        allowed_updates: input.allowedUpdates ?? ["message"],
      });
      return Array.isArray(result) ? result : [];
    },
    async setMyCommands(token, commands) {
      await call<boolean>(token, "setMyCommands", { commands });
    },
    async sendMessage(token, input) {
      const result = await call<{ message_id?: number }>(token, "sendMessage", {
        chat_id: input.chatId,
        text: input.text,
      });
      return { messageId: result?.message_id };
    },
  };
}

export class InMemoryTelegramStore implements TelegramStore {
  readonly configs = new Map<string, TelegramBotConfig>();
  readonly challenges = new Map<string, TelegramPairingChallenge>();
  readonly bindings = new Map<string, TelegramChatBinding>();
  readonly updates = new Set<string>();
  readonly deliveries = new Map<string, TelegramRunDelivery>();
  readonly pollingOffsets = new Map<string, number>();

  async getBotConfig(botId: string): Promise<TelegramBotConfig | null> { return this.configs.get(botId) ?? null; }
  async putBotConfig(config: TelegramBotConfig): Promise<void> { this.configs.set(config.botId, config); }
  async createPairingChallenge(challenge: TelegramPairingChallenge): Promise<void> { this.challenges.set(challenge.tokenDigest, challenge); }
  async consumePairingChallenge(tokenDigest: string, now: number): Promise<TelegramPairingChallenge | null> {
    const challenge = this.challenges.get(tokenDigest);
    if (!challenge) return null;
    this.challenges.delete(tokenDigest);
    return challenge.expiresAt > now ? challenge : null;
  }
  async getChatBinding(botId: string, chatId: string, telegramUserId: string): Promise<TelegramChatBinding | null> {
    return this.bindings.get(`${botId}:${chatId}:${telegramUserId}`) ?? null;
  }
  async putChatBinding(binding: TelegramChatBinding): Promise<void> {
    this.bindings.set(`${binding.botId}:${binding.chatId}:${binding.telegramUserId}`, binding);
  }
  async listChatBindings(botId: string): Promise<TelegramChatBinding[]> {
    return [...this.bindings.values()].filter((binding) => binding.botId === botId);
  }
  async deleteChatBinding(botId: string, chatId: string, telegramUserId: string): Promise<boolean> {
    return this.bindings.delete(`${botId}:${chatId}:${telegramUserId}`);
  }
  async claimUpdate(botId: string, updateId: number): Promise<boolean> {
    const key = `${botId}:${updateId}`;
    if (this.updates.has(key)) return false;
    this.updates.add(key);
    return true;
  }
  async releaseUpdate(botId: string, updateId: number): Promise<void> { this.updates.delete(`${botId}:${updateId}`); }
  async putRunDelivery(delivery: TelegramRunDelivery): Promise<void> {
    const old = this.deliveries.get(delivery.runId);
    this.deliveries.set(delivery.runId, { ...delivery, status: old?.status ?? delivery.status ?? "pending" });
  }
  async getRunDelivery(runId: string): Promise<TelegramRunDelivery | null> { return this.deliveries.get(runId) ?? null; }
  async claimRunDelivery(runId: string): Promise<TelegramRunDelivery | null> {
    const old = this.deliveries.get(runId);
    if (!old) return null;
    if (old.status === "sent" || old.status === "needs_review") return null;
    if (old.status === "sending") {
      old.status = "needs_review";
      return null;
    }
    old.status = "sending";
    return { ...old };
  }
  async markRunDeliverySent(runId: string): Promise<void> {
    const old = this.deliveries.get(runId);
    if (old) this.deliveries.set(runId, { ...old, status: "sent" });
  }
  async markRunDeliveryNeedsReview(runId: string): Promise<void> {
    const old = this.deliveries.get(runId);
    if (old) this.deliveries.set(runId, { ...old, status: "needs_review" });
  }
  async getPollingOffset(botId: string): Promise<number | null> { return this.pollingOffsets.get(botId) ?? null; }
  async setPollingOffset(botId: string, offset: number): Promise<void> { this.pollingOffsets.set(botId, offset); }
}

export class TelegramService {
  private readonly api: TelegramApi;
  private readonly now: () => number;
  private readonly onMessage?: TelegramServiceOptions["onMessage"];
  private readonly onCommand?: TelegramServiceOptions["onCommand"];
  private readonly commandsForBot?: TelegramServiceOptions["commandsForBot"];
  private readonly onPaired?: TelegramServiceOptions["onPaired"];
  private readonly pollTimeoutSeconds: number;

  constructor(private readonly options: TelegramServiceOptions) {
    this.api = options.api ?? createTelegramApi(fetch, options.apiBaseUrl);
    this.now = options.now ?? Date.now;
    this.onMessage = options.onMessage;
    this.onCommand = options.onCommand;
    this.commandsForBot = options.commandsForBot;
    this.onPaired = options.onPaired;
    this.pollTimeoutSeconds = Math.min(25, Math.max(0, Math.floor(options.pollTimeoutSeconds ?? 5)));
  }

  /** Explicit admin configure action: validates token, then registers Telegram's webhook. */
  async configureBot(input: {
    botId: string;
    token: string;
    webhookUrl?: string;
    webhookSecret?: string;
    transport?: "webhook" | "polling";
  }): Promise<TelegramPublicBotConfig> {
    if (!input.botId || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.botId)) throw new Error("botId is invalid");
    const token = validateToken(input.token);
    const transport = input.transport ?? "webhook";
    if (transport !== "webhook" && transport !== "polling") throw new Error("transport is invalid");
    const webhookUrl = transport === "webhook"
      ? validateWebhookUrl(String(input.webhookUrl ?? ""))
      : undefined;
    const webhookSecret = validateSecret(input.webhookSecret ?? randomToken(32));
    const identity = await this.api.getMe(token);
    const username = telegramUsername(identity);
    if (transport === "webhook") {
      await this.api.setWebhook(token, { url: webhookUrl!, secretToken: webhookSecret });
    } else {
      if (!this.api.deleteWebhook) throw new Error("Telegram polling is unavailable");
      await this.api.deleteWebhook(token);
    }
    await this.publishCommands(input.botId, token);
    const previous = await this.options.store.getBotConfig(input.botId);
    const config: TelegramBotConfig = {
      botId: input.botId,
      token,
      telegramBotId: identity.id,
      username,
      firstName: String(identity.first_name ?? "Telegram bot").slice(0, 160),
      transport,
      webhookUrl,
      webhookSecret,
      createdAt: previous?.createdAt ?? nowIso(this.now()),
      updatedAt: nowIso(this.now()),
    };
    await this.options.store.putBotConfig(config);
    return publicConfig(config);
  }

  /** Alias useful for HTTP handlers whose action is named simply "configure". */
  async configure(input: {
    botId: string;
    token: string;
    webhookUrl?: string;
    webhookSecret?: string;
    transport?: "webhook" | "polling";
  }): Promise<TelegramPublicBotConfig> {
    return this.configureBot(input);
  }

  /** Poll one bounded getUpdates request. Configure the bot with transport=polling first. */
  async pollOnce(botId: string, timeoutSeconds = this.pollTimeoutSeconds): Promise<TelegramPollOutcome> {
    const config = await this.options.store.getBotConfig(botId);
    if (!config) return { polled: false, updates: 0, accepted: 0, error: "not_configured" };
    if (config.transport !== "polling") return { polled: false, updates: 0, accepted: 0, error: "not_polling" };
    if (!this.api.getUpdates) return { polled: false, updates: 0, accepted: 0, error: "unsupported" };
    const timeout = Math.min(25, Math.max(0, Math.floor(timeoutSeconds)));
    const offset = await this.options.store.getPollingOffset?.(botId) ?? undefined;
    let updates: TelegramUpdate[];
    try {
      updates = await this.api.getUpdates(config.token, { offset: offset ?? undefined, timeout, allowedUpdates: ["message"] });
    } catch (error) {
      const status = error instanceof TelegramApiError ? error.status : (error as { status?: number })?.status;
      return { polled: true, updates: 0, accepted: 0, ...(offset === undefined ? {} : { offset }), error: status === 409 ? "conflict" : "api_error" };
    }
    let accepted = 0;
    let nextOffset = offset;
    for (const update of updates) {
      if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) break;
      const result = await this.processUpdate(botId, config, update);
      if (result.status !== 200 || !result.accepted) break;
      accepted++;
      nextOffset = update.update_id + 1;
      if (this.options.store.setPollingOffset) await this.options.store.setPollingOffset(botId, nextOffset);
    }
    return { polled: true, updates: updates.length, accepted, ...(nextOffset === undefined ? {} : { offset: nextOffset }) };
  }

  async getBotConfig(botId: string): Promise<TelegramPublicBotConfig | null> {
    const config = await this.options.store.getBotConfig(botId);
    return config ? publicConfig(config) : null;
  }

  /** Refreshes Telegram's command menu from the server-side catalog without re-entering a token. */
  async refreshCommands(botId: string): Promise<{ count: number }> {
    const config = await this.options.store.getBotConfig(botId);
    if (!config) throw new Error("Telegram bot is not configured");
    return this.publishCommands(botId, config.token);
  }

  async listPairings(botId: string): Promise<TelegramChatBinding[]> {
    return this.options.store.listChatBindings(botId);
  }

  async revokePairing(input: { botId: string; chatId: number | string; telegramUserId: number | string }): Promise<boolean> {
    return this.options.store.deleteChatBinding(input.botId, normalizeId(input.chatId), normalizeId(input.telegramUserId));
  }

  /** Generates the Telegram deep link shown in the UI and a one-time pairing challenge. */
  async createPairingLink(input: {
    botId: string;
    /** Must be derived from the authenticated server session, never browser input. */
    ownerUserId: string;
    /** Existing control-worker thread selected by the authenticated owner. */
    threadId: string;
    expectedTelegramUserId?: number | string;
    ttlSeconds?: number;
  }): Promise<TelegramPairingLink> {
    const config = await this.options.store.getBotConfig(input.botId);
    if (!config) throw new Error("Telegram bot is not configured");
    if (typeof input.ownerUserId !== "string" || !input.ownerUserId.trim()) throw new Error("ownerUserId is required");
    if (typeof input.threadId !== "string" || !input.threadId.trim()) throw new Error("threadId is required");
    const ttl = input.ttlSeconds ?? DEFAULT_PAIRING_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60) throw new Error("ttlSeconds is out of range");
    const nonce = randomToken(32);
    const now = this.now();
    const expiresAt = now + ttl * 1000;
    await this.options.store.createPairingChallenge({
      tokenDigest: await digest(nonce),
      botId: input.botId,
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      expectedTelegramUserId: input.expectedTelegramUserId === undefined ? undefined : normalizeId(input.expectedTelegramUserId),
      expiresAt,
      createdAt: now,
    });
    return {
      botId: input.botId,
      deepLink: `https://t.me/${config.username}?start=${nonce}`,
      expiresAt: nowIso(expiresAt),
    };
  }

  /**
   * Authenticates and routes one Telegram webhook. The caller should turn the
   * returned status into the HTTP status and return a small JSON body. Update
   * contents are never included in the result.
   */
  async handleWebhook(botId: string, request: Request): Promise<TelegramWebhookOutcome> {
    const config = await this.options.store.getBotConfig(botId);
    if (!config) return { status: 404, accepted: false, reason: "unknown_bot" };
    const providedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(providedSecret, config.webhookSecret)) return { status: 401, accepted: false, reason: "invalid_secret" };
    const length = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_WEBHOOK_BODY) return { status: 413, accepted: false };
    let update: TelegramUpdate;
    try {
      const raw = await request.text();
      if (textEncoder.encode(raw).byteLength > MAX_WEBHOOK_BODY) return { status: 413, accepted: false };
      update = JSON.parse(raw) as TelegramUpdate;
    } catch {
      return { status: 400, accepted: false, reason: "invalid_json" };
    }
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0)
      return { status: 400, accepted: false, reason: "invalid_update" };
    return this.processUpdate(botId, config, update);
  }

  /** Shared authenticated-update pipeline used by webhooks and getUpdates. */
  private async processUpdate(botId: string, config: TelegramBotConfig, update: TelegramUpdate): Promise<TelegramWebhookOutcome> {
    if (!(await this.options.store.claimUpdate(botId, update.update_id)))
      return { status: 200, accepted: true, duplicate: true };
    try {
      const message = update.message;
      const from = message?.from;
      const chat = message?.chat;
      const text = typeof message?.text === "string" ? message.text : "";
      if (!from || from.is_bot === true || !chat || !text.trim())
        return { status: 200, accepted: true, reason: "empty_message" };
      const telegramUserId = normalizeId(from.id);
      const chatId = normalizeId(chat.id);
      const startPayload = parseStart(text, config.username);
      if (startPayload !== null || /^\/start(?:@|\s|$)/.test(text.trim())) {
        if (!startPayload) {
          const existing = await this.options.store.getChatBinding(botId, chatId, telegramUserId);
          await this.safeSend(config, chatId, existing
            ? "Ready. Send a message or use /new to start another conversation. Use /help for commands."
            : "This chat is not paired. Open the Telegram link from Settings → Telegram → Link my Telegram account, then press Start.");
          return { status: 200, accepted: true, reason: existing ? undefined : "unpaired_chat" };
        }
        const challenge = await this.options.store.consumePairingChallenge(await digest(startPayload), this.now());
        if (!challenge || challenge.botId !== botId || (challenge.expectedTelegramUserId && challenge.expectedTelegramUserId !== telegramUserId)) {
          await this.safeSend(config, chatId, "This pairing link is invalid or expired.");
          return { status: 200, accepted: true, reason: "expired_pairing" };
        }
        const binding: TelegramChatBinding = {
          botId,
          ownerUserId: challenge.ownerUserId,
          threadId: challenge.threadId,
          telegramUserId,
          chatId,
          createdAt: nowIso(this.now()),
        };
        await this.options.store.putChatBinding(binding);
        if (this.onPaired) await this.onPaired(binding);
        await this.safeSend(config, chatId, "Connected. Send me a message to run your bot.");
        return { status: 200, accepted: true, paired: true };
      }
      const binding = await this.options.store.getChatBinding(botId, chatId, telegramUserId);
      if (!binding) {
        await this.safeSend(config, chatId, "Use the pairing link from the app before sending messages.");
        return { status: 200, accepted: true, reason: "unpaired_chat" };
      }
      const command = parseCommand(text, config.username);
      if (command) {
        if (this.onCommand) {
          const result = await this.onCommand({
            botId,
            ownerUserId: binding.ownerUserId,
            threadId: binding.threadId,
            telegramUserId,
            chatId,
            commandName: command.name,
            commandText: command.input,
            messageId: message?.message_id,
            updateId: update.update_id,
            idempotencyKey: `telegram:${botId}:${update.update_id}`,
            update,
          });
          const nextBinding = result?.threadId && result.threadId !== binding.threadId
            ? { ...binding, threadId: result.threadId }
            : binding;
          if (nextBinding !== binding) await this.options.store.putChatBinding(nextBinding);
          if (result?.runId)
            await this.options.store.putRunDelivery({ runId: result.runId, botId, chatId, telegramUserId, createdAt: nowIso(this.now()) });
          if (result?.text) await this.safeSend(config, chatId, redactSecret(result.text, config.token));
          return { status: 200, accepted: true, routed: true, runId: result?.runId };
        }
        if (command.name === "help") {
          await this.safeSend(config, chatId, "Commands: /new, /help, /status, /stop");
          return { status: 200, accepted: true, routed: false };
        }
        await this.safeSend(config, chatId, "This command is not available yet. Use /help.");
        return { status: 200, accepted: true, routed: false };
      }
      if (!this.onMessage) return { status: 200, accepted: true, routed: false };
      const result = await this.onMessage({
        botId,
        ownerUserId: binding.ownerUserId,
        threadId: binding.threadId,
        telegramUserId,
        chatId,
        text,
        messageId: message?.message_id,
        updateId: update.update_id,
        idempotencyKey: `telegram:${botId}:${update.update_id}`,
        update,
      });
      if (result && typeof result.runId === "string" && result.runId.length > 0)
        await this.options.store.putRunDelivery({ runId: result.runId, botId, chatId, telegramUserId, createdAt: nowIso(this.now()) });
      return { status: 200, accepted: true, routed: true, runId: result?.runId };
    } catch {
      if (this.options.store.releaseUpdate) await this.options.store.releaseUpdate(botId, update.update_id);
      return { status: 500, accepted: false, reason: "handler_error" };
    }
  }

  /** Call this from the worker's run reconciliation/alarm after a run becomes terminal. */
  async deliverRunCompletion(completion: RunCompletion): Promise<{ sent: boolean; chunks: number; needsReview?: boolean }> {
    const existing = await this.options.store.getRunDelivery(completion.runId);
    if (!existing) return { sent: false, chunks: 0 };
    let delivery: TelegramRunDelivery | null = null;
    if (this.options.store.claimRunDelivery) {
      delivery = await this.options.store.claimRunDelivery(completion.runId);
      if (!delivery) {
        const state = await this.options.store.getRunDelivery(completion.runId);
        return { sent: false, chunks: 0, ...(state?.status === "needs_review" ? { needsReview: true } : {}) };
      }
    } else {
      if (existing.status === "sent" || existing.status === "needs_review" || existing.status === "sending")
        return { sent: false, chunks: 0, ...(existing.status === "needs_review" ? { needsReview: true } : {}) };
      delivery = { ...existing, status: "sending" };
      await this.options.store.putRunDelivery(delivery);
    }
    const config = await this.options.store.getBotConfig(delivery.botId);
    if (!config) {
      if (this.options.store.markRunDeliveryNeedsReview) await this.options.store.markRunDeliveryNeedsReview(completion.runId);
      else await this.options.store.putRunDelivery({ ...delivery, status: "needs_review" });
      return { sent: false, chunks: 0, needsReview: true };
    }
    const prefix = completion.status === "succeeded" ? "" : `Run ${completion.status}: `;
    const text = redactSecret(`${prefix}${completion.output ?? completion.error ?? "(no output)"}`, config.token);
    let chunks = 0;
    try {
      for (const chunk of splitMessage(text)) {
        await this.api.sendMessage(config.token, { chatId: delivery.chatId, text: chunk });
        chunks++;
      }
    } catch {
      // A network error can happen after Telegram accepted a message. Never
      // silently resend on the next alarm; surface an explicit review state.
      if (this.options.store.markRunDeliveryNeedsReview) await this.options.store.markRunDeliveryNeedsReview(completion.runId);
      else await this.options.store.putRunDelivery({ ...delivery, status: "needs_review" });
      return { sent: false, chunks, needsReview: true };
    }
    if (this.options.store.markRunDeliverySent) await this.options.store.markRunDeliverySent(completion.runId);
    else await this.options.store.putRunDelivery({ ...delivery, status: "sent" });
    return { sent: true, chunks };
  }

  private async safeSend(config: TelegramBotConfig, chatId: string, text: string): Promise<void> {
    try { await this.api.sendMessage(config.token, { chatId, text }); } catch { /* webhook acknowledgement must not leak Bot API errors */ }
  }

  private async publishCommands(botId: string, token: string): Promise<{ count: number }> {
    if (!this.api.setMyCommands) return { count: 0 };
    const nativeCommands = this.commandsForBot ? await this.commandsForBot(botId) : [];
    const commands = normalizeCommands([...DEFAULT_COMMANDS, ...nativeCommands]);
    await this.api.setMyCommands(token, commands);
    return { count: commands.length };
  }
}

export function webhookJson(outcome: TelegramWebhookOutcome): Response {
  return new Response(JSON.stringify({ ok: outcome.accepted, ...(outcome.duplicate ? { duplicate: true } : {}) }), {
    status: outcome.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export { DurableObjectTelegramStore } from "./sql-store";
export type { SqlStorage } from "./sql-store";
