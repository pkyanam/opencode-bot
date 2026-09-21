import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTelegramStore,
  TelegramService,
  type TelegramApi,
  type TelegramBotIdentity,
} from "../src/index";

function fakeApi(overrides: Partial<TelegramApi> = {}): TelegramApi & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  const identity: TelegramBotIdentity = { id: 123, is_bot: true, first_name: "Build Bot", username: "build_bot" };
  return {
    sent,
    getMe: vi.fn(async () => identity),
    setWebhook: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_token, input) => { sent.push(input); return {}; }),
    ...overrides,
  } as TelegramApi & { sent: Array<{ chatId: string; text: string }> };
}

async function request(update: unknown, secret = "webhook-secret") {
  return new Request("https://bot.test/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });
}

describe("TelegramService", () => {
  it("validates with getMe, explicitly sets the webhook, and never returns secrets", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi();
    const service = new TelegramService({ store, api, now: () => 1_700_000_000_000 });
    const configured = await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });

    expect(api.getMe).toHaveBeenCalledWith("bot-token-secret");
    expect(api.setWebhook).toHaveBeenCalledWith("bot-token-secret", expect.objectContaining({ url: "https://example.test/hooks/telegram" }));
    expect(configured).toMatchObject({ botId: "bot_1", username: "build_bot" });
    expect(JSON.stringify(configured)).not.toContain("bot-token-secret");
    expect(JSON.stringify(configured)).not.toContain("webhookSecret");
  });

  it("creates a short-lived deep link and consumes its nonce only once", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi();
    let now = 1_700_000_000_000;
    const service = new TelegramService({ store, api, now: () => now });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });
    const link = await service.createPairingLink({ botId: "bot_1", ownerUserId: "user_1", threadId: "thr_1", ttlSeconds: 60 });
    expect(link.deepLink).toMatch(/^https:\/\/t\.me\/build_bot\?start=[A-Za-z0-9_-]{40,50}$/);

    const paired = await service.handleWebhook("bot_1", await request({ update_id: 1, message: { message_id: 7, from: { id: 42 }, chat: { id: 42 }, text: link.deepLink.split("start=")[1] ? `/start ${link.deepLink.split("start=")[1]}` : "" } }, "secret_123456789"));
    expect(paired).toMatchObject({ accepted: true, paired: true });
    const replay = await service.handleWebhook("bot_1", await request({ update_id: 2, message: { from: { id: 43 }, chat: { id: 43 }, text: link.deepLink.split("start=")[1] ? `/start ${link.deepLink.split("start=")[1]}` : "" } }, "secret_123456789"));
    expect(replay).toMatchObject({ accepted: true, reason: "expired_pairing" });

    const expired = await service.createPairingLink({ botId: "bot_1", ownerUserId: "user_1", threadId: "thr_1", ttlSeconds: 30 });
    now += 31_000;
    const expiredResult = await service.handleWebhook("bot_1", await request({ update_id: 3, message: { from: { id: 42 }, chat: { id: 42 }, text: `/start ${expired.deepLink.split("start=")[1]}` } }, "secret_123456789"));
    expect(expiredResult).toMatchObject({ accepted: true, reason: "expired_pairing" });
  });

  it("rejects bad webhook secrets before parsing and routes only paired messages", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi();
    const routed: any[] = [];
    const service = new TelegramService({ store, api, onMessage: async (message) => { routed.push(message); return { runId: "run_1" }; } });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });
    const bad = await service.handleWebhook("bot_1", await request({ update_id: 1, message: { from: { id: 42 }, chat: { id: 42 }, text: "hello" } }, "wrong-secret"));
    expect(bad).toMatchObject({ status: 401, reason: "invalid_secret" });

    const link = await service.createPairingLink({ botId: "bot_1", ownerUserId: "owner", threadId: "thr" });
    const nonce = link.deepLink.split("start=")[1];
    await service.handleWebhook("bot_1", await request({ update_id: 2, message: { from: { id: 42 }, chat: { id: 42 }, text: `/start ${nonce}` } }, "secret_123456789"));
    const delivered = await service.handleWebhook("bot_1", await request({ update_id: 3, message: { message_id: 9, from: { id: 42 }, chat: { id: 42 }, text: "run this" } }, "secret_123456789"));
    expect(delivered).toMatchObject({ accepted: true, routed: true, runId: "run_1" });
    expect(routed[0]).toMatchObject({ botId: "bot_1", ownerUserId: "owner", threadId: "thr", text: "run this", idempotencyKey: "telegram:bot_1:3" });
    const duplicate = await service.handleWebhook("bot_1", await request({ update_id: 3, message: { from: { id: 42 }, chat: { id: 42 }, text: "run this" } }, "secret_123456789"));
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });
    expect(routed).toHaveLength(1);
  });

  it("delivers a terminal run result to the paired chat in Telegram-sized chunks", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi();
    const service = new TelegramService({ store, api });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });
    const link = await service.createPairingLink({ botId: "bot_1", ownerUserId: "owner", threadId: "thread" });
    await service.handleWebhook("bot_1", await request({ update_id: 1, message: { from: { id: 42 }, chat: { id: 42 }, text: `/start ${link.deepLink.split("start=")[1]}` } }, "secret_123456789"));
    await store.putRunDelivery({ runId: "run_1", botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: new Date().toISOString() });
    await store.putChatBinding({ botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: new Date().toISOString() });
    const result = await service.deliverRunCompletion({ runId: "run_1", status: "succeeded", output: "x".repeat(8_500) });
    expect(result).toEqual({ sent: true, chunks: 3 });
    expect(api.sent.at(-1)?.chatId).toBe("42");
    expect(api.sent.every((message) => message.text.length <= 4096)).toBe(true);
    expect(await service.deliverRunCompletion({ runId: "run_1", status: "succeeded", output: "again" })).toEqual({ sent: false, chunks: 0 });
  });

  it("moves uncertain completion sends to needs_review instead of replaying them", async () => {
    const store = new InMemoryTelegramStore();
    let calls = 0;
    const api = fakeApi({ sendMessage: vi.fn(async (_token, input) => {
      calls++;
      if (calls === 1) throw new Error("connection reset after acceptance");
      return { messageId: 1 };
    }) });
    const service = new TelegramService({ store, api });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });
    await store.putRunDelivery({ runId: "run_uncertain", botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: new Date().toISOString() });
    await store.putChatBinding({ botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: new Date().toISOString() });
    expect(await service.deliverRunCompletion({ runId: "run_uncertain", status: "succeeded", output: "result" })).toMatchObject({ sent: false, needsReview: true });
    expect(await service.deliverRunCompletion({ runId: "run_uncertain", status: "succeeded", output: "result" })).toMatchObject({ sent: false, needsReview: true });
    expect(calls).toBe(1);
  });

  it("supports bounded polling with durable offsets and the same pairing/router pipeline", async () => {
    const store = new InMemoryTelegramStore();
    const updates = [{ update_id: 10, message: { from: { id: 42 }, chat: { id: 42 }, text: "hello" } }];
    const api = fakeApi({
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn(async (_token, input) => {
        expect(input.timeout).toBeLessThanOrEqual(25);
        expect(input.offset).toBeUndefined();
        return updates;
      }),
    });
    const routed: string[] = [];
    const service = new TelegramService({ store, api, onMessage: async (message) => { routed.push(message.text); return { runId: "poll-run" }; }, pollTimeoutSeconds: 60 });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", transport: "polling" });
    expect(api.deleteWebhook).toHaveBeenCalledWith("bot-token-secret");
    const link = await service.createPairingLink({ botId: "bot_1", ownerUserId: "owner", threadId: "thread" });
    updates[0].message.text = `/start ${link.deepLink.split("start=")[1]}`;
    const paired = await service.pollOnce("bot_1", 60);
    expect(paired).toMatchObject({ polled: true, updates: 1, accepted: 1, offset: 11 });
    expect(await store.getPollingOffset("bot_1")).toBe(11);

    (api.getUpdates as ReturnType<typeof vi.fn>).mockImplementation(async (_token, input) => {
      expect(input.offset).toBe(11);
      return [{ update_id: 11, message: { from: { id: 42 }, chat: { id: 42 }, text: "poll me" } }];
    });
    const routedResult = await service.pollOnce("bot_1");
    expect(routedResult).toMatchObject({ accepted: 1, offset: 12 });
    expect(routed).toEqual(["poll me"]);
  });

  it("does not make polling API calls when the bot is unconfigured or webhook-configured", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi({ getUpdates: vi.fn(async () => []) });
    const service = new TelegramService({ store, api });
    expect(await service.pollOnce("missing")).toMatchObject({ polled: false, error: "not_configured" });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram" });
    expect(await service.pollOnce("bot_1")).toMatchObject({ polled: false, error: "not_polling" });
    expect(api.getUpdates).not.toHaveBeenCalled();
  });

  it("reports Telegram's single-poller conflict without exposing API details", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi({ deleteWebhook: vi.fn(async () => undefined), getUpdates: vi.fn(async () => { throw { status: 409, message: "token should not escape" }; }) });
    const service = new TelegramService({ store, api });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", transport: "polling" });
    expect(await service.pollOnce("bot_1", 0)).toEqual({ polled: true, updates: 0, accepted: 0, error: "conflict" });
  });

  it("publishes built-in and authenticated native commands, and routes commands only after pairing", async () => {
    const store = new InMemoryTelegramStore();
    const api = fakeApi({ setMyCommands: vi.fn(async () => undefined) });
    const commands: any[] = [];
    const service = new TelegramService({
      store,
      api,
      commandsForBot: async () => [{ command: "/compact", description: "Compact this conversation" }],
      onCommand: async (command) => {
        commands.push(command);
        return { text: `Handled ${command.commandName}`, threadId: "thread-new" };
      },
    });
    await service.configureBot({ botId: "bot_1", token: "bot-token-secret", webhookUrl: "https://example.test/hooks/telegram", webhookSecret: "secret_123456789" });
    expect(api.setMyCommands).toHaveBeenCalledWith("bot-token-secret", [
      { command: "new", description: "Start a new conversation" },
      { command: "help", description: "Show available commands" },
      { command: "status", description: "Show current run status" },
      { command: "stop", description: "Stop the active run" },
      { command: "compact", description: "Compact this conversation" },
    ]);
    expect(await service.refreshCommands("bot_1")).toEqual({ count: 5 });
    expect(api.setMyCommands).toHaveBeenCalledTimes(2);
    const unpaired = await service.handleWebhook("bot_1", await request({ update_id: 20, message: { from: { id: 7 }, chat: { id: 7 }, text: "/new" } }, "secret_123456789"));
    expect(unpaired).toMatchObject({ accepted: true, reason: "unpaired_chat" });
    expect(commands).toHaveLength(0);
    await service.handleWebhook("bot_1", await request({ update_id: 20_1, message: { from: { id: 7 }, chat: { id: 7 }, text: "/start" } }, "secret_123456789"));
    expect(api.sent.at(-1)?.text).toContain("not paired");
    const link = await service.createPairingLink({ botId: "bot_1", ownerUserId: "owner", threadId: "thread-old" });
    await service.handleWebhook("bot_1", await request({ update_id: 21, message: { from: { id: 7 }, chat: { id: 7 }, text: `/start ${link.deepLink.split("start=")[1]}` } }, "secret_123456789"));
    const commandResult = await service.handleWebhook("bot_1", await request({ update_id: 22, message: { message_id: 8, from: { id: 7 }, chat: { id: 7 }, text: "/new project-x" } }, "secret_123456789"));
    expect(commandResult).toMatchObject({ accepted: true, routed: true });
    expect(commands[0]).toMatchObject({ commandName: "new", commandText: "project-x", threadId: "thread-old" });
    expect((await store.getChatBinding("bot_1", "7", "7"))?.threadId).toBe("thread-new");
    expect(api.sent.at(-1)?.text).toBe("Handled new");
    await service.handleWebhook("bot_1", await request({ update_id: 23, message: { from: { id: 7 }, chat: { id: 7 }, text: "/start" } }, "secret_123456789"));
    expect(api.sent.at(-1)?.text).toContain("Ready");
  });
});
