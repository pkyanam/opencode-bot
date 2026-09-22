import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRegistry } from "./memory-registry";
const databases: DatabaseSync[] = [];
function fixture(legacy = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE bots(id TEXT PRIMARY KEY); INSERT INTO bots VALUES ('cloud'),('mac'),('other')",
  );
  if (legacy)
    db.exec(
      "CREATE TABLE memory_items(id TEXT PRIMARY KEY,bot_id TEXT,content TEXT,kind TEXT,created_at TEXT,updated_at TEXT); INSERT INTO memory_items VALUES ('old','cloud','Always use pnpm','preference','2026-01-01','2026-01-01')",
    );
  const sql = {
    exec(query: string, ...args: any[]) {
      const s = db.prepare(query);
      const reads = s.columns().length > 0;
      return {
        toArray: () => (reads ? s.all(...args) : []),
        rowsWritten: reads ? 0 : Number(s.run(...args).changes),
      };
    },
  };
  const registry = new MemoryRegistry(sql, (fn) => {
    db.exec("SAVEPOINT memory_write");
    try {
      const result = fn();
      db.exec("RELEASE memory_write");
      return result;
    } catch (e) {
      db.exec("ROLLBACK TO memory_write");
      db.exec("RELEASE memory_write");
      throw e;
    }
  });
  registry.init();
  return { db, registry, sql };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
describe("workspace memory registry", () => {
  it("migrates legacy memory once without losing IDs or introducing grants", () => {
    const { registry } = fixture(true);
    expect(registry.read("old")).toMatchObject({
      botId: "cloud",
      content: "Always use pnpm",
      visibility: "private",
      revision: 1,
    });
    registry.init();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list({}, { botId: "mac" })).toEqual([]);
  });
  it("shares across nodes, propagates edits and revokes immediately", () => {
    const { registry } = fixture();
    const original = registry.create(
      {
        content: "Fisker wiring diagrams are in the archive",
        sharedBotIds: ["mac"],
        visibility: "shared",
      },
      { botId: "cloud", threadId: "t1" },
    );
    expect(registry.list({ q: "wiring" }, { botId: "mac" })[0].id).toBe(
      original.id,
    );
    expect(() => registry.read(original.id, { botId: "other" })).toThrow();
    const updated = registry.update(
      original.id,
      { content: "Fisker wiring diagrams moved to manuals", revision: 1 },
      { botId: "cloud" },
    );
    expect(registry.read(original.id, { botId: "mac" }).content).toContain(
      "moved",
    );
    registry.update(
      original.id,
      { visibility: "private", revision: updated.revision },
      { botId: "cloud" },
    );
    expect(registry.list({ q: "Fisker" }, { botId: "mac" })).toEqual([]);
  });
  it("prevents identity spoofing and shared recipient mutation or history disclosure", () => {
    const { registry } = fixture();
    const item = registry.create(
      { botId: "mac", content: "A private decision", visibility: "workspace" },
      { botId: "cloud" },
    );
    expect(item.botId).toBe("cloud");
    expect(() =>
      registry.update(
        item.id,
        { content: "hijacked", revision: 1 },
        { botId: "mac" },
      ),
    ).toThrow(/read-only/);
    expect(() => registry.remove(item.id, { botId: "mac" }, 1)).toThrow(
      /read-only/,
    );
    expect(() => registry.history(item.id, { botId: "mac" })).toThrow(/owner/);
  });
  it("rejects stale edits and preserves bounded history", () => {
    const { registry } = fixture();
    let item = registry.create({ botId: "cloud", content: "Version 1" });
    for (let i = 0; i < 25; i++)
      item = registry.update(item.id, {
        content: `Version ${i + 2}`,
        revision: item.revision,
      });
    expect(registry.history(item.id)).toHaveLength(20);
    expect(() =>
      registry.update(item.id, { content: "stale", revision: 1 }),
    ).toThrow(/changed/);
  });
  it("searches with punctuation safely and retrieves only authorized memory within budget", () => {
    const { registry } = fixture();
    registry.create({
      botId: "cloud",
      content: "Cloudflare deployments use Wrangler",
      pinned: true,
    });
    registry.create({
      botId: "mac",
      content: "Cloudflare SECRET",
      visibility: "private",
    });
    registry.create({
      botId: "cloud",
      content: "a".repeat(10000),
      title: "huge",
    });
    expect(
      registry.list({ q: 'Cloudflare " OR *', botId: "cloud" }),
    ).toHaveLength(1);
    expect(
      registry.recall("cloud", "Cloudflare").map((m) => m.content),
    ).toEqual(["Cloudflare deployments use Wrangler"]);
  });
  it("deduplicates retries and validates grants, kinds and limits", () => {
    const { registry } = fixture();
    const input = {
      botId: "cloud",
      content: "Use the archive",
      visibility: "shared",
      sharedBotIds: ["mac"],
    };
    expect(registry.create(input).id).toBe(registry.create(input).id);
    expect(() =>
      registry.create({ ...input, sharedBotIds: ["missing"] }),
    ).toThrow(/existing bot/);
    expect(() => registry.create({ ...input, sharedBotIds: [] })).toThrow(
      /at least one/,
    );
    expect(() =>
      registry.create({ ...input, content: "x".repeat(16001) }),
    ).toThrow();
    expect(() => registry.create({ ...input, kind: "unknown" })).toThrow();
  });
  it("forgets content from search and history, and preserves shared knowledge on author deletion", () => {
    const { registry } = fixture();
    const privateItem = registry.create({
      botId: "cloud",
      content: "Private secret",
    });
    const shared = registry.create({
      botId: "cloud",
      content: "Shared archive",
      visibility: "shared",
      sharedBotIds: ["mac"],
    });
    registry.deleteBot("cloud");
    expect(() => registry.read(privateItem.id)).toThrow();
    expect(registry.read(shared.id, { botId: "mac" })).toMatchObject({
      botId: null,
      content: "Shared archive",
    });
    registry.remove(shared.id);
    expect(registry.list({ q: "archive" })).toEqual([]);
  });
});
