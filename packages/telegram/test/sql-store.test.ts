import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DurableObjectTelegramStore } from "../src/index";

function storage() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      exec(query: string, ...args: unknown[]) {
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...args as any[]) : [];
        const result = statement.columns().length ? undefined : statement.run(...args as any[]);
        return { toArray: () => rows as Record<string, unknown>[], rowsWritten: Number(result?.changes ?? 0) };
      },
    },
  };
}

describe("DurableObjectTelegramStore", () => {
  it("persists one-time challenges, update receipts, pairings, and delivery state", async () => {
    const fixture = storage();
    const store = new DurableObjectTelegramStore(fixture.sql);
    await store.putBotConfig({ botId: "bot_1", token: "server-secret", telegramBotId: 1, username: "build_bot", firstName: "Build", transport: "webhook", webhookUrl: "https://example.test/hook", webhookSecret: "secret_123456789", createdAt: "now", updatedAt: "now" });
    expect((await store.getBotConfig("bot_1"))?.transport).toBe("webhook");
    await store.createPairingChallenge({ tokenDigest: "digest", botId: "bot_1", ownerUserId: "owner", threadId: "thread", expiresAt: 2_000, createdAt: 1_000 });
    expect(await store.consumePairingChallenge("digest", 1_999)).toMatchObject({ botId: "bot_1", ownerUserId: "owner" });
    expect(await store.consumePairingChallenge("digest", 1_999)).toBeNull();
    expect(await store.claimUpdate("bot_1", 10)).toBe(true);
    expect(await store.claimUpdate("bot_1", 10)).toBe(false);
    await store.putChatBinding({ botId: "bot_1", chatId: "42", telegramUserId: "42", ownerUserId: "owner", threadId: "thread", createdAt: "now" });
    expect(await store.listChatBindings("bot_1")).toHaveLength(1);
    await store.putRunDelivery({ runId: "run_1", botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: "now" });
    expect(await store.claimRunDelivery("run_1")).toMatchObject({ status: "sending" });
    await store.markRunDeliverySent("run_1");
    expect(await store.claimRunDelivery("run_1")).toBeNull();
    expect((await store.getRunDelivery("run_1"))?.status).toBe("sent");
    await store.setPollingOffset("bot_1", 77);
    expect(await store.getPollingOffset("bot_1")).toBe(77);
    fixture.db.close();
  });

  it("marks an orphaned send as needs_review after a restart", async () => {
    const fixture = storage();
    const store = new DurableObjectTelegramStore(fixture.sql);
    await store.putRunDelivery({ runId: "run_2", botId: "bot_1", chatId: "42", telegramUserId: "42", createdAt: "now" });
    expect(await store.claimRunDelivery("run_2")).toMatchObject({ status: "sending" });
    const restarted = new DurableObjectTelegramStore(fixture.sql);
    expect(await restarted.claimRunDelivery("run_2")).toBeNull();
    expect((await restarted.getRunDelivery("run_2"))?.status).toBe("needs_review");
    fixture.db.close();
  });
});
