import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRegistry } from "./memory-registry";
import { HindsightEngine } from "./hindsight-engine";
import { HindsightError } from "./hindsight-client";

const dbs: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(
    "CREATE TABLE bots(id TEXT PRIMARY KEY,name TEXT); INSERT INTO bots VALUES ('bot','Bot'),('other','Other');",
  );
  const sql = {
    exec(query: string, ...args: any[]) {
      const s = db.prepare(query);
      const read = s.columns().length > 0;
      return {
        toArray: () => (read ? s.all(...args) : []),
        rowsWritten: read ? 0 : Number(s.run(...args).changes),
      };
    },
  };
  const registry = new MemoryRegistry(sql);
  registry.init();
  const schedule = vi.fn();
  const engine = new HindsightEngine({
    sql,
    registry,
    schedule,
    client: () => ({}) as any,
  });
  engine.configure({ enabled: true, url: "https://hindsight.example" });
  return { db, sql, registry, engine, schedule };
}
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

describe("HindsightEngine projection state", () => {
  it("re-submits a pre-POST operation when polling gets 404, preserving its idempotency key", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "Authorized fact" });
    let retains = 0,
      polls = 0;
    const ids: string[] = [];
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_bank: string, _items: unknown[], id: string) => {
        retains++;
        ids.push(id);
        return { operation_id: id };
      }),
      operation: vi.fn(async () => {
        polls++;
        if (polls === 1) throw new HindsightError("missing", 404);
        return { status: "completed" };
      }),
      mentalModels: vi.fn(async () => ({ items: [] })),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    await e.tick();
    await e.tick();
    expect(retains).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(
      (
        f.sql
          .exec("SELECT status FROM hindsight_projections WHERE bot_id='bot'")
          .toArray()[0] as any
      ).status,
    ).toBe("ready");
  });

  it("retains model definitions across instance rotation and recreates remote models", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "Fact" });
    let bankCalls = 0,
      modelCalls = 0;
    const client = {
      createBank: vi.fn(async () => {
        bankCalls++;
        return {};
      }),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
      createMentalModel: vi.fn(async () => {
        modelCalls++;
        return { mental_model_id: `remote-${modelCalls}`, operation_id: "op" };
      }),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.createModel("bot", { name: "Profile", query: "What matters?" });
    expect(modelCalls).toBe(1);
    e.instanceChanged("native-2");
    await e.tick();
    await e.tick();
    expect(modelCalls).toBe(2);
    expect(bankCalls).toBe(3);
  });

  it("rejects reads until the authorized projection is ready and catches mid-query rotation", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "Fact" });
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
      recall: vi.fn(async () => ({ results: [] })),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await expect(e.query("bot", "recall", "fact")).rejects.toMatchObject({
      status: 409,
    });
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    expect(await e.query("bot", "recall", "fact")).toMatchObject({
      provider: "hindsight",
    });
  });

  it("rotates immediately when an authorized shared memory is revoked", async () => {
    const f = fixture();
    const item = f.registry.create({
      botId: "bot",
      content: "shared secret",
      visibility: "shared",
      sharedBotIds: ["other"],
    });
    const banks: string[] = [];
    const client = {
      createBank: vi.fn(async (bank: string) => {
        banks.push(bank);
        return {};
      }),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    const before = (
      f.sql
        .exec("SELECT bank_id FROM hindsight_projections WHERE bot_id='other'")
        .toArray()[0] as any
    ).bank_id;
    f.registry.update(
      item.id,
      { visibility: "private", revision: item.revision },
      { botId: "bot" },
    );
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    const after = (
      f.sql
        .exec("SELECT bank_id FROM hindsight_projections WHERE bot_id='other'")
        .toArray()[0] as any
    ).bank_id;
    expect(after).not.toBe(before);
    expect(banks).toContain(before);
  });

  it("retries a failed bank create after the backoff instead of retaining into an uncreated bank", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "fact" });
    let attempts = 0;
    const client = {
      createBank: vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary");
        return {};
      }),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    expect(
      (
        f.sql
          .exec("SELECT status FROM hindsight_projections WHERE bot_id='bot'")
          .toArray()[0] as any
      ).status,
    ).toBe("failed");
    f.sql.exec(
      "UPDATE hindsight_projections SET updated_at='2000-01-01T00:00:00.000Z'",
    );
    await e.tick();
    expect(attempts).toBe(2);
  });

  it("retries an immutable retain payload when a memory changes while the operation is pending", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "before" });
    let first = true;
    const payloads: unknown[] = [];
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, items: unknown[], id: string) => {
        payloads.push(items);
        return { operation_id: id };
      }),
      operation: vi.fn(async () => {
        if (first) {
          first = false;
          throw new HindsightError("missing", 404);
        }
        return { status: "completed" };
      }),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    f.registry.create({ botId: "bot", content: "added while pending" });
    await e.tick();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
  });

  it("does not send old endpoint bank IDs to a newly configured server", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "fact" });
    const deleted: string[] = [];
    const urls: string[] = [];
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
      deleteBank: vi.fn(async (bank: string) => {
        deleted.push(bank);
      }),
    };
    const e = new HindsightEngine({
      ...f,
      client: (settings) => {
        urls.push(settings.url);
        return client as any;
      },
    });
    await e.tick();
    e.configure({ url: "https://new-hindsight.example" });
    await e.tick();
    expect(urls).toContain("https://new-hindsight.example");
    expect(deleted).toEqual([]);
  });

  it("considers a missing garbage bank already cleaned", async () => {
    const f = fixture();
    f.sql.exec("DELETE FROM bots");
    f.sql.exec("INSERT INTO hindsight_garbage VALUES ('gone')");
    const client = {
      deleteBank: vi.fn(async () => {
        throw new HindsightError("gone", 404);
      }),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    expect(f.sql.exec("SELECT * FROM hindsight_garbage").toArray()).toEqual([]);
  });

  it("drops an in-flight query result when authorization changes during remote recall", async () => {
    const f = fixture();
    const item = f.registry.create({ botId: "bot", content: "secret" });
    let release!: () => void;
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
      recall: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ results: [{ text: "secret" }] });
          }),
      ),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    const pending = e.query("bot", "recall", "secret");
    f.registry.update(
      item.id,
      { content: "revoked", visibility: "private", revision: item.revision },
      { botId: "bot" },
    );
    release();
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });

  it("clears an API key when switching endpoints unless a replacement is explicit", async () => {
    const f = fixture();
    f.engine.configure({ apiKey: "old-secret" });
    f.engine.configure({ url: "https://next-hindsight.example" });
    expect(f.engine.settings().apiKey).toBeUndefined();
    f.engine.configure({
      url: "https://third-hindsight.example",
      apiKey: "new-secret",
    });
    expect(f.engine.settings().apiKey).toBe("new-secret");
  });

  it("rejects malformed URLs, unsupported settings, and string booleans", () => {
    const f = fixture();
    expect(() => f.engine.configure({ url: "definitely-not-a-url" })).toThrow(
      /valid HTTPS/,
    );
    expect(() => f.engine.configure({ unexpected: true })).toThrow(
      /Unsupported/,
    );
    expect(() => f.engine.configure({ enabled: "false" })).toThrow(/boolean/);
    expect(() => f.engine.configure({ autoCapture: 0 })).toThrow(/boolean/);
  });

  it("reconciles a deterministic model ID after a lost create acknowledgement and retries failures", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "fact" });
    let creates = 0,
      fail = true;
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({
        operation_id: id,
      })),
      operation: vi.fn(async () => ({ status: "completed" })),
      createMentalModel: vi.fn(async (_b: string, input: { id: string }) => {
        creates++;
        if (fail) {
          fail = false;
          throw new HindsightError("already exists", 409);
        }
        return { mental_model_id: input.id };
      }),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick();
    await e.tick();
    await e.tick();
    await e.tick();
    const created = await e.createModel("bot", {
      name: "Model",
      query: "What?",
    });
    expect(created.status).toBe("ready");
    expect(creates).toBe(1);
    await e.tick();
    expect(creates).toBe(1);
  });

  it("does not resurrect a projection when the endpoint changes during retain", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "fact" });
    let release!: () => void;
    const oldBanks: string[] = [];
    const client = {
      createBank: vi.fn(async (bank: string) => { oldBanks.push(bank); return {}; }),
      retain: vi.fn(() => new Promise((resolve) => { release = () => resolve({ operation_id: "late-op" }); })),
      operation: vi.fn(async () => ({ status: "completed" })),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    const running = e.tick();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    e.configure({ url: "https://replacement-hindsight.example" });
    release();
    await running;
    expect(f.sql.exec("SELECT * FROM hindsight_projections WHERE bank_id=?", oldBanks[0]).toArray()).toEqual([]);
  });

  it("does not schedule an idle ready projection without pending model work", async () => {
    const f = fixture();
    const client = { createBank: vi.fn(async () => ({})) };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    f.schedule.mockClear();
    await e.tick();
    f.schedule.mockClear();
    await e.tick();
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it("stops polling terminal or missing mental-model operations", async () => {
    const f = fixture();
    f.registry.create({ botId: "bot", content: "fact" });
    let polls = 0, modelCreated = false;
    const client = {
      createBank: vi.fn(async () => ({})),
      retain: vi.fn(async (_b: string, _i: unknown[], id: string) => ({ operation_id: id })),
      operation: vi.fn(async () => { polls++; return { status: modelCreated ? "failed" : "completed" }; }),
      createMentalModel: vi.fn(async (_b: string, input: { id: string }) => { modelCreated = true; return { mental_model_id: input.id, operation_id: "model-op" }; }),
    };
    const e = new HindsightEngine({ ...f, client: () => client as any });
    await e.tick(); await e.tick(); await e.tick(); await e.tick(); await e.tick(); await e.tick(); await e.tick(); await e.tick();
    await e.createModel("bot", { name: "Model", query: "What?" });
    await e.tick();
    const row = f.sql.exec("SELECT status,operation_id FROM hindsight_models").toArray()[0] as any;
    expect(row).toMatchObject({ status: "failed", operation_id: null });
    const after = polls;
    await e.tick();
    expect(polls).toBe(after);
  });
});
