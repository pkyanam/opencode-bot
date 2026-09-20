import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NodeRegistry } from "../packages/nodes/src/index";

const databases: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const statement = db.prepare(query);
      const columns = statement.columns();
      const rows = columns.length ? statement.all(...args as any[]) : [];
      const result = columns.length ? undefined : statement.run(...args as any[]);
      return { rowsWritten: Number(result?.changes ?? 0), toArray: () => rows };
    },
  };
  let now = new Date("2026-09-20T12:00:00.000Z");
  const registry = new NodeRegistry(sql, { now: () => now, randomId: (prefix) => `${prefix}_fixed_${Math.random()}` });
  return { db, registry, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const registration = (token: string) => ({ pairingToken: token, name: "Office Mac", platform: "macos", arch: "arm64", agentVersion: "0.1.0", capabilities: { runner: true, desktop: false, browser: false, maxParallelJobs: 1 } });

describe("durable node registry", () => {
  it("redeems a pairing token exactly once and stores only digests", async () => {
    const f = fixture();
    const pairing = await f.registry.createPairing({ label: "office", ttlMs: 60_000 });
    const enrolled = await f.registry.register(registration(pairing.token));
    expect(enrolled.node.id).toMatch(/^node_/);
    expect(enrolled.nodeSecret).toMatch(/^ns_/);
    await expect(f.registry.register(registration(pairing.token))).rejects.toMatchObject({ status: 401 });
    const stored = f.db.prepare("SELECT token_hash, secret_hash FROM node_pairings p JOIN nodes n ON 1=1").get() as any;
    expect(stored.token_hash).not.toContain(pairing.token);
    expect(stored.secret_hash).not.toContain(enrolled.nodeSecret);
  });

  it("expires pairings, reports heartbeat availability, and revokes credentials", async () => {
    const f = fixture();
    const expired = await f.registry.createPairing({ ttlMs: 10_000 });
    f.advance(10_001);
    await expect(f.registry.register(registration(expired.token))).rejects.toMatchObject({ status: 401 });
    const valid = await f.registry.createPairing();
    const enrolled = await f.registry.register(registration(valid.token));
    expect(f.registry.list()[0].online).toBe(true);
    f.advance(90_001);
    expect(f.registry.list()[0].online).toBe(false);
    f.advance(-90_001);
    await f.registry.heartbeat(enrolled.node.id, enrolled.nodeSecret, { capabilities: { browser: true } });
    expect(f.registry.list()[0].capabilities.browser).toBe(true);
    f.registry.revoke(enrolled.node.id);
    await expect(f.registry.heartbeat(enrolled.node.id, enrolled.nodeSecret)).rejects.toMatchObject({ status: 401 });
  });

  it("leases one job, rejects duplicate completion, and records result", async () => {
    const f = fixture();
    const pairing = await f.registry.createPairing();
    const enrolled = await f.registry.register(registration(pairing.token));
    const job = await f.registry.enqueue(enrolled.node.id, { kind: "runner.run", run: { runId: "run_1", prompt: "hello" } });
    const leased = await f.registry.poll(enrolled.node.id, enrolled.nodeSecret);
    expect(leased).toMatchObject({ id: job.id, status: "leased" });
    const progress = await f.registry.submitProgress(enrolled.node.id, enrolled.nodeSecret, job.id, { result: { status: "waiting_approval", events: [{ seq: 1, type: "approval.requested" }] } });
    expect(progress).toMatchObject({ status: "leased", result: { status: "waiting_approval" } });
    expect(await f.registry.poll(enrolled.node.id, enrolled.nodeSecret)).toBeNull();
    const completed = await f.registry.submitResult(enrolled.node.id, enrolled.nodeSecret, job.id, { ok: true, result: { status: "succeeded" } });
    expect(completed).toMatchObject({ status: "succeeded", result: { status: "succeeded" } });
    await expect(f.registry.submitResult(enrolled.node.id, enrolled.nodeSecret, job.id, { ok: true })).rejects.toMatchObject({ status: 409 });
  });

  it("moves an expired lease to review instead of replaying an ambiguous run", async () => {
    const f = fixture();
    const pairing = await f.registry.createPairing();
    const enrolled = await f.registry.register(registration(pairing.token));
    const job = await f.registry.enqueue(enrolled.node.id, { kind: "runner.run", run: { runId: "run_ambiguous", prompt: "side effect" } });
    expect(await f.registry.poll(enrolled.node.id, enrolled.nodeSecret)).toMatchObject({ id: job.id, status: "leased" });
    f.advance(45_001);
    expect(f.registry.getJob(job.id)).toMatchObject({ id: job.id, status: "needs_review" });
    expect(await f.registry.poll(enrolled.node.id, enrolled.nodeSecret)).toBeNull();
    await expect(f.registry.submitResult(enrolled.node.id, enrolled.nodeSecret, job.id, { ok: true })).rejects.toMatchObject({ status: 409 });
  });
});

describe("node HTTP contract", () => {
  it("keeps admin and node credentials separate", async () => {
    const f = fixture();
    const req = (path: string, init: RequestInit = {}) => f.registry.handle(new Request(`https://control.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } }), { adminAuthorized: true });
    expect((await f.registry.handle(new Request("https://control.test/api/nodes", { method: "GET" }))).status).toBe(401);
    const created = await req("/api/nodes/pairing", { method: "POST", body: JSON.stringify({}) });
    expect(created.status).toBe(201);
    const pairing = await created.json() as any;
    const enrolled = await f.registry.handle(new Request("https://control.test/api/nodes/register", { method: "POST", body: JSON.stringify(registration(pairing.token)) }));
    expect(enrolled.status).toBe(201);
    const credentials = await enrolled.json() as any;
    expect((await f.registry.handle(new Request(`https://control.test/api/nodes/${credentials.node.id}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${credentials.nodeSecret}`, "content-type": "application/json" }, body: "{}" }))).status).toBe(200);
    expect((await f.registry.handle(new Request("https://control.test/api/nodes", { method: "GET" }), { adminAuthorized: true })).status).toBe(200);
  });
});
