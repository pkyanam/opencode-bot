import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MemoryQueryJobs } from "./memory-query-jobs";
import { MemoryError } from "./memory-registry";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...args: any[]) { const s = db.prepare(query); const read = s.columns().length > 0; return { toArray: () => read ? s.all(...args) : [], rowsWritten: read ? 0 : Number(s.run(...args).changes) }; } };
  let now = 1_000;
  const auth = new Map([["bot", "rev-1"]]);
  const engine = { query: vi.fn(async () => ({ results: [{ text: "answer" }] })) };
  const jobs = new MemoryQueryJobs(sql, engine, (bot) => auth.get(bot) ?? "missing", () => now, () => "job-1");
  return { db, sql, jobs, engine, auth, advance(ms: number) { now += ms; } };
}

describe("MemoryQueryJobs", () => {
  it("persists, claims, and completes one job", async () => {
    const f = fixture();
    const created = f.jobs.create("bot", "reflect", "What do I know?", "low");
    expect(created).toMatchObject({ id: "job-1", status: "queued", botId: "bot" });
    expect((await f.jobs.run("job-1"))?.status).toBe("succeeded");
    expect(f.engine.query).toHaveBeenCalledTimes(1);
    expect(f.jobs.get("job-1")).toMatchObject({ status: "succeeded", result: { results: [{ text: "answer" }] } });
    expect(f.jobs.latest("bot")).toMatchObject({ id: "job-1", query: "What do I know?", budget: "low" });
    f.db.close();
  });

  it("cancels a running job and ignores its late result", async () => {
    const f = fixture(); let release!: (value: any) => void;
    f.engine.query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.jobs.create("bot", "recall", "question");
    const running = f.jobs.run("job-1");
    expect(f.jobs.cancel("job-1").status).toBe("cancelled");
    release({ results: ["late"] }); await running;
    expect(f.jobs.get("job-1")).toMatchObject({ status: "cancelled" });
    f.db.close();
  });

  it("fails closed when authorization changes before result retrieval or commit", async () => {
    const f = fixture();
    f.jobs.create("bot", "recall", "question");
    f.auth.set("bot", "rev-2");
    expect(f.jobs.get("job-1")).toMatchObject({ status: "failed", error: "Memory authorization changed; retry the query." });
    f.auth.set("bot", "rev-1");
    await f.jobs.run("job-1");
    f.auth.set("bot", "rev-2");
    expect(f.jobs.get("job-1")).toMatchObject({ status: "failed", error: "Memory authorization changed; retry the query." });
    f.db.close();
  });

  it("expires and purges old jobs", () => {
    const f = fixture(); f.jobs.create("bot", "recall", "question"); f.advance(15 * 60_001);
    expect(() => f.jobs.get("job-1")).toThrow(/expired/); expect(f.jobs.purge()).toBe(0); f.db.close();
  });

  it("fails a queued job left behind after an isolate restart", () => {
    const f = fixture(); f.jobs.create("bot", "recall", "question"); f.advance(60_001);
    expect(f.jobs.get("job-1")).toMatchObject({ status: "failed", error: "Memory query timed out; retry the query." }); f.db.close();
  });

  it("limits UTF-8 result bytes and tolerates a purged late job", async () => {
    const f = fixture(); f.engine.query.mockResolvedValueOnce({ text: "🙂".repeat(200_000) } as any);
    f.jobs.create("bot", "recall", "question");
    expect((await f.jobs.run("job-1"))?.status).toBe("failed");
    f.sql.exec("DELETE FROM hindsight_query_jobs WHERE id=?", "job-1");
    let release!: () => void;
    f.engine.query.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true } as any); }));
    f.jobs.create("bot", "reflect", "second");
    const running = f.jobs.run("job-1");
    f.sql.exec("DELETE FROM hindsight_query_jobs WHERE id=?", "job-1"); release();
    expect(await running).toBeUndefined(); f.db.close();
  });

  it("retries only bounded warmup/indexing failures", async () => {
    const f = fixture(); let attempts = 0; const sleep = vi.fn(async () => undefined);
    f.engine.query.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) throw new MemoryError(attempts === 1 ? 503 : 409, attempts === 1 ? "Hindsight is starting its database and models." : "Hindsight is indexing the latest authorized memories.");
      return { results: [] };
    });
    const jobs = new MemoryQueryJobs(f.sql, f.engine, (bot) => f.auth.get(bot) ?? "missing", () => 1_000, () => "job-1", sleep);
    jobs.create("bot", "recall", "question");
    expect((await jobs.run("job-1"))?.status).toBe("succeeded");
    expect(attempts).toBe(3); expect(sleep).toHaveBeenCalledTimes(2); f.db.close();
  });

  it("does not retry authorization/provider failures and cancels during warmup", async () => {
    const f = fixture();
    f.engine.query.mockRejectedValueOnce(new MemoryError(401, "Invalid memory engine credential"));
    f.jobs.create("bot", "recall", "question");
    expect((await f.jobs.run("job-1"))?.status).toBe("failed");
    expect(f.engine.query).toHaveBeenCalledTimes(1);
    f.sql.exec("DELETE FROM hindsight_query_jobs WHERE id=?", "job-1");
    let jobs!: MemoryQueryJobs;
    f.engine.query.mockRejectedValue(new MemoryError(503, "Hindsight is starting its database and models."));
    jobs = new MemoryQueryJobs(f.sql, f.engine, (bot) => f.auth.get(bot) ?? "missing", () => 1_000, () => "job-1", async () => { jobs.cancel("job-1"); });
    jobs.create("bot", "recall", "question");
    expect((await jobs.run("job-1"))?.status).toBe("cancelled");
    expect(f.engine.query).toHaveBeenCalledTimes(2);
    f.db.close();
  });

  it("keeps a long-running provider call valid inside the eleven-minute stale window", async () => {
    const f = fixture();
    let release!: (value: any) => void;
    f.engine.query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.jobs.create("bot", "recall", "question");
    const running = f.jobs.run("job-1");
    await Promise.resolve();
    f.advance(10 * 60_000);
    expect(f.jobs.get("job-1")).toMatchObject({ status: "running" });
    f.advance(2 * 60_000);
    expect(f.jobs.get("job-1")).toMatchObject({ status: "failed" });
    release({ results: [] });
    await running; f.db.close();
  });
});
