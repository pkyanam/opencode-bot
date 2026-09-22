import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export type SqlResult = {
  toArray(): Record<string, unknown>[];
  rowsWritten: number;
};
export type LocalSql = { exec(query: string, ...args: unknown[]): SqlResult };

function sqlAdapter(db: DatabaseSync): LocalSql {
  return {
    exec(query, ...args) {
      const statement = db.prepare(query);
      const read = statement.columns().length > 0;
      if (read) {
        const rows = statement.all(...(args as any[])) as Record<
          string,
          unknown
        >[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const result = statement.run(...(args as any[]));
      return { toArray: () => [], rowsWritten: Number(result.changes ?? 0) };
    },
  };
}

export type LocalStorage = {
  sql: LocalSql;
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  transactionSync<T>(fn: () => T): T;
  setAlarm(at: number): void;
  setAlarmHandler(handler: () => Promise<void>): void;
  waitUntil(promise: Promise<unknown>): void;
  drain(): Promise<void>;
  close(): void;
};

export function openLocalStorage(filename: string): LocalStorage {
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS __platform_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const sql = sqlAdapter(db);
  let alarmTimer: NodeJS.Timeout | undefined;
  let alarmHandler: (() => Promise<void>) | undefined;
  let alarmRunning = false;
  const scheduleAlarm = (at: number) => {
    if (alarmTimer) clearTimeout(alarmTimer);
    const delay = Math.min(Math.max(0, at - Date.now()), 2_147_000_000);
    alarmTimer = setTimeout(() => {
      if (!alarmHandler || alarmRunning) return;
      const operation = (async () => {
        const current = await storageGet<number>("__platform_alarm");
        if (current !== at) return;
        sql.exec(
          "DELETE FROM __platform_kv WHERE key=? AND value=?",
          "__platform_alarm",
          JSON.stringify(at),
        );
        alarmRunning = true;
        try {
          await alarmHandler!();
        } catch {
          const newer = await storageGet<number>("__platform_alarm");
          if (newer === undefined) {
            const retry = Date.now() + 1000;
            sql.exec(
              "INSERT INTO __platform_kv(key,value) VALUES('__platform_alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              JSON.stringify(retry),
            );
            scheduleAlarm(retry);
          }
        } finally {
          alarmRunning = false;
        }
      })();
      pending.push(operation);
      void operation.then(
        () => {
          const i = pending.indexOf(operation);
          if (i >= 0) pending.splice(i, 1);
        },
        () => {
          const i = pending.indexOf(operation);
          if (i >= 0) pending.splice(i, 1);
        },
      );
    }, delay);
    alarmTimer.unref?.();
  };
  const storageGet = async <T>(key: string): Promise<T | undefined> => {
    const row = sql
      .exec("SELECT value FROM __platform_kv WHERE key=?", key)
      .toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(String(row.value)) as T;
    } catch {
      return row.value as T;
    }
  };
  const pending: Promise<unknown>[] = [];
  return {
    sql,
    async get<T>(key: string) {
      return storageGet<T>(key);
    },
    async put(key, value) {
      sql.exec(
        "INSERT INTO __platform_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        JSON.stringify(value),
      );
    },
    async delete(key) {
      sql.exec("DELETE FROM __platform_kv WHERE key=?", key);
    },
    transactionSync<T>(fn: () => T) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* preserve original */
        }
        throw error;
      }
    },
    setAlarm(at) {
      sql.exec(
        "INSERT INTO __platform_kv(key,value) VALUES('__platform_alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(at),
      );
      scheduleAlarm(at);
    },
    setAlarmHandler(handler) {
      alarmHandler = handler;
      void this.get<number>("__platform_alarm").then((at) => {
        if (typeof at === "number") scheduleAlarm(at);
      });
    },
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
      void promise.then(
        () => {
          const i = pending.indexOf(promise);
          if (i >= 0) pending.splice(i, 1);
        },
        () => {
          const i = pending.indexOf(promise);
          if (i >= 0) pending.splice(i, 1);
        },
      );
    },
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
    close() {
      if (alarmTimer) clearTimeout(alarmTimer);
      db.close();
    },
  };
}

export type AlarmScheduler = {
  schedule(key: string, at: number, payload?: unknown): void;
  runDue(
    handler: (key: string, payload: unknown) => Promise<void>,
  ): Promise<number>;
  start(handler: (key: string, payload: unknown) => Promise<void>): void;
  stop(): void;
};

export function createAlarmScheduler(
  storage: LocalStorage,
  intervalMs = 1000,
): AlarmScheduler {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS __platform_alarms (key TEXT PRIMARY KEY, due_at INTEGER NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
  );
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const schedule = (key: string, at: number, payload: unknown = {}) =>
    storage.sql.exec(
      "INSERT INTO __platform_alarms(key,due_at,payload) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET due_at=excluded.due_at,payload=excluded.payload",
      key,
      at,
      JSON.stringify(payload),
    );
  const runDue = async (
    handler: (key: string, payload: unknown) => Promise<void>,
  ) => {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      const rows = storage.sql
        .exec(
          "SELECT key,payload,due_at FROM __platform_alarms WHERE due_at<=? ORDER BY due_at LIMIT 32",
          Date.now(),
        )
        .toArray();
      for (const row of rows) {
        const key = String(row.key);
        const payload = JSON.parse(String(row.payload));
        const dueAt = Number(row.due_at);
        const encoded = String(row.payload);
        try {
          await handler(key, payload);
          storage.sql.exec(
            "DELETE FROM __platform_alarms WHERE key=? AND due_at=? AND payload=?",
            key,
            dueAt,
            encoded,
          );
        } catch {
          storage.sql.exec(
            "UPDATE __platform_alarms SET attempts=attempts+1,due_at=? WHERE key=? AND due_at=? AND payload=?",
            Date.now() + 1000,
            key,
            dueAt,
            encoded,
          );
        }
        count++;
      }
    } finally {
      running = false;
    }
    return count;
  };
  return {
    schedule,
    runDue,
    start(handler) {
      if (!timer) timer = setInterval(() => void runDue(handler), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type LocalObject = {
  size?: number;
  uploaded?: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array>;
};

function safeKey(root: string, key: string): string {
  if (
    !key ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.split("/").includes("..")
  )
    throw new Error("invalid object key");
  const path = resolve(root, key);
  if (relative(root, path).startsWith(".."))
    throw new Error("invalid object key");
  return path;
}

export class LocalObjectStore {
  constructor(private readonly root: string) {}
  private dataRoot() {
    return join(this.root, "objects");
  }
  private metadataRoot() {
    return join(this.root, "metadata");
  }
  async init() {
    await mkdir(this.dataRoot(), { recursive: true });
    await mkdir(this.metadataRoot(), { recursive: true });
  }
  private meta(key: string) {
    return join(
      this.metadataRoot(),
      createHash("sha256").update(key).digest("hex") + ".json",
    );
  }
  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options: {
      customMetadata?: Record<string, string>;
      httpMetadata?: Record<string, string>;
    } = {},
  ) {
    const target = safeKey(this.dataRoot(), key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    const out = createWriteStream(tmp, { flags: "wx", mode: 0o600 });
    let size = 0;
    try {
      if (value instanceof ReadableStream) {
        let streamError: unknown;
        out.once("error", (error) => {
          streamError = error;
        });
        const reader = value.getReader();
        try {
          while (true) {
            if (streamError) throw streamError;
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (!out.write(item.value))
              await new Promise<void>((resolve, reject) => {
                const drain = () => {
                  cleanup();
                  resolve();
                };
                const error = (cause: Error) => {
                  cleanup();
                  reject(cause);
                };
                const cleanup = () => {
                  out.off("drain", drain);
                  out.off("error", error);
                };
                out.once("drain", drain);
                out.once("error", error);
              });
          }
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
        out.end();
        await new Promise<void>((resolve, reject) => {
          out.once("close", resolve);
          out.once("error", reject);
        });
      } else {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        size = bytes.byteLength;
        await new Promise<void>((resolve, reject) => {
          out.once("error", reject);
          out.once("close", resolve);
          out.end(bytes);
        });
      }
      const handle = await open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
      const metadataPath = this.meta(key);
      await mkdir(dirname(metadataPath), { recursive: true });
      await writeFile(
        metadataPath,
        JSON.stringify({
          size,
          uploaded: new Date().toISOString(),
          ...options,
        }),
        { mode: 0o600 },
      );
      const metadataHandle = await open(metadataPath, "r+");
      try {
        await metadataHandle.sync();
      } finally {
        await metadataHandle.close();
      }
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
  async head(key: string): Promise<LocalObject | null> {
    const target = safeKey(this.dataRoot(), key);
    try {
      const info = await stat(target);
      let metadata: any = {};
      try {
        metadata = JSON.parse(await readFile(this.meta(key), "utf8"));
      } catch {}
      return {
        size: info.size,
        uploaded: metadata.uploaded ? new Date(metadata.uploaded) : info.mtime,
        customMetadata: metadata.customMetadata,
        httpMetadata: metadata.httpMetadata,
        arrayBuffer: async () => {
          const bytes = await readFile(target);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        },
      };
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<LocalObject | null> {
    const target = safeKey(this.dataRoot(), key);
    try {
      const info = await stat(target);
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? info.size - offset;
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > info.size
      )
        throw new Error("invalid object range");
      let metadata: any = {};
      try {
        metadata = JSON.parse(await readFile(this.meta(key), "utf8"));
      } catch {}
      const end = Math.min(info.size, offset + length);
      const stream =
        end > offset
          ? createReadStream(target, { start: offset, end: end - 1 })
          : Readable.from([]);
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      const arrayBuffer = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of end > offset
          ? createReadStream(target, { start: offset, end: end - 1 })
          : Readable.from([]))
          chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      };
      return {
        size: end - offset,
        uploaded: metadata.uploaded ? new Date(metadata.uploaded) : info.mtime,
        customMetadata: metadata.customMetadata,
        httpMetadata: metadata.httpMetadata,
        arrayBuffer,
        body,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const target = safeKey(this.dataRoot(), key);
      await rm(target, { force: true });
      await rm(this.meta(key), { force: true });
    }
  }
  async list(
    options: { cursor?: string; limit?: number; prefix?: string } = {},
  ) {
    const all: { key: string; size: number; uploaded: Date }[] = [];
    const walk = async (dir: string) => {
      for (const name of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) await walk(path);
        else if (!name.name.includes(".tmp-")) {
          const key = relative(this.dataRoot(), path);
          if (!options.prefix || key.startsWith(options.prefix)) {
            const info = await stat(path);
            let metadata: any = {};
            try {
              metadata = JSON.parse(await readFile(this.meta(key), "utf8"));
            } catch {}
            all.push({
              key,
              size: info.size,
              uploaded: metadata.uploaded
                ? new Date(metadata.uploaded)
                : info.mtime,
            });
          }
        }
      }
    };
    await walk(this.dataRoot());
    all.sort((a, b) => a.key.localeCompare(b.key));
    const parsed = options.cursor === undefined ? 0 : Number(options.cursor);
    const start = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    const limit = Math.max(1, Math.min(1000, options.limit ?? 1000));
    const objects = all.slice(start, start + limit);
    return {
      objects,
      truncated: start + objects.length < all.length,
      ...(start + objects.length < all.length
        ? { cursor: String(start + objects.length) }
        : {}),
    };
  }
}
