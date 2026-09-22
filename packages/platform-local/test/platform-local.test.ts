import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAlarmScheduler,
  LocalObjectStore,
  openLocalStorage,
} from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "platform-local-"));
  dirs.push(dir);
  return { dir, db: join(dir, "state.sqlite"), objects: join(dir, "objects") };
}

describe("local durable platform", () => {
  it("persists KV and transaction rollback across reopen", async () => {
    const f = await fixture();
    const first = openLocalStorage(f.db);
    await first.put("answer", 42);
    expect(await first.get("answer")).toBe(42);
    expect(() =>
      first.transactionSync(() => {
        first.sql.exec("CREATE TABLE tx_test(value TEXT)");
        first.sql.exec("INSERT INTO tx_test VALUES(?)", "x");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(
      first.sql
        .exec("SELECT name FROM sqlite_master WHERE name='tx_test'")
        .toArray(),
    ).toEqual([]);
    first.close();
    const second = openLocalStorage(f.db);
    expect(await second.get("answer")).toBe(42);
    second.close();
  });

  it("runs durable alarms and retries failures", async () => {
    const f = await fixture();
    const storage = openLocalStorage(f.db);
    const scheduler = createAlarmScheduler(storage, 5);
    scheduler.schedule("one", Date.now(), { value: 7 });
    let attempts = 0;
    expect(
      await scheduler.runDue(async (_key, payload) => {
        attempts++;
        if (attempts === 1) throw new Error("retry");
        expect(payload).toEqual({ value: 7 });
      }),
    ).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(
      await scheduler.runDue(async () => {
        attempts++;
      }),
    ).toBe(1);
    expect(attempts).toBe(2);
    scheduler.stop();
    storage.close();
  });

  it("does not delete a same-key alarm rescheduled by its handler", async () => {
    const f = await fixture();
    const storage = openLocalStorage(f.db);
    const scheduler = createAlarmScheduler(storage);
    scheduler.schedule("loop", Date.now(), { n: 1 });
    await scheduler.runDue(async () =>
      scheduler.schedule("loop", Date.now(), { n: 2 }),
    );
    expect(
      await scheduler.runDue(async (_key, payload) =>
        expect(payload).toEqual({ n: 2 }),
      ),
    ).toBe(1);
    scheduler.stop();
    storage.close();
  });

  it("writes safe objects atomically, supports ranges, list cursors and restart", async () => {
    const f = await fixture();
    const store = new LocalObjectStore(f.objects);
    await store.init();
    await store.put(
      "checkpoints/a.bin",
      new TextEncoder().encode("0123456789"),
      { customMetadata: { sha256: "x" } },
    );
    await store.put("uploads/b.txt", new TextEncoder().encode("hello"));
    await store.put("empty.bin", new Uint8Array());
    const ranged = await store.get("checkpoints/a.bin", {
      range: { offset: 2, length: 4 },
    });
    expect(new TextDecoder().decode(await ranged!.arrayBuffer())).toBe("2345");
    expect((await store.head("checkpoints/a.bin"))?.size).toBe(10);
    const emptyRange = await store.get("checkpoints/a.bin", {
      range: { offset: 4, length: 0 },
    });
    expect(emptyRange?.size).toBe(0);
    expect(new Uint8Array(await emptyRange!.arrayBuffer())).toHaveLength(0);
    await expect(
      store.get("checkpoints/a.bin", { range: { offset: 1.5, length: 1 } }),
    ).rejects.toThrow("invalid object range");
    await expect(
      store.get("checkpoints/a.bin", {
        range: { offset: Number.NaN, length: 1 },
      }),
    ).rejects.toThrow("invalid object range");
    const page = await store.list({ limit: 1 });
    expect(page.objects).toHaveLength(1);
    expect(page.truncated).toBe(true);
    const next = await store.list({ cursor: page.cursor, limit: 1 });
    expect(next.objects[0].key).toBe("empty.bin");
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(
      "invalid object key",
    );
    await store.delete("uploads/b.txt");
    expect(await store.get("uploads/b.txt")).toBeNull();
    const empty = await store.get("empty.bin");
    expect(empty?.size).toBe(0);
    expect(new Uint8Array(await empty!.arrayBuffer())).toHaveLength(0);
    expect((await store.head("checkpoints/a.bin"))?.customMetadata).toEqual({
      sha256: "x",
    });
    expect(
      await readFile(join(f.objects, "objects/checkpoints/a.bin"), "utf8"),
    ).toBe("0123456789");
  });

  it("cancels a failing input stream without leaving a partial object", async () => {
    const f = await fixture();
    const store = new LocalObjectStore(f.objects);
    await store.init();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("source failed"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(store.put("broken.bin", source)).rejects.toThrow(
      "source failed",
    );
    expect(await store.get("broken.bin")).toBeNull();
    expect(cancelled).toBe(false);
  });

  it("runs a persisted alarm once, retries failure, and drains newly queued work", async () => {
    const f = await fixture();
    const storage = openLocalStorage(f.db);
    let calls = 0;
    storage.setAlarmHandler(async () => {
      calls++;
      if (calls === 1) throw new Error("retry");
      storage.waitUntil(Promise.resolve());
    });
    storage.setAlarm(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(calls).toBe(2);
    await storage.drain();
    storage.close();
    const reopened = openLocalStorage(f.db);
    let replayed = false;
    reopened.setAlarmHandler(async () => {
      replayed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replayed).toBe(false);
    reopened.close();
  });
});
