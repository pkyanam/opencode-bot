import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/computer-cloudflare/src/index", () => ({ CloudflareComputerProvider: class {} }));
vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {} }));
import worker, { Workspace } from "../apps/control-worker/src/index";

const dbs: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:"); dbs.push(db); const alarms: number[] = [];
  const storage: any = { sql: { exec(query: string, ...args: any[]) { const s = db.prepare(query); const rows = s.columns().length ? s.all(...args) : []; const changes = s.columns().length ? 0 : Number(s.run(...args).changes); return { toArray: () => rows, rowsWritten: changes }; } }, setAlarm: async (n: number) => alarms.push(n), deleteAlarm: async () => {} };
  const deleted: string[] = []; const env: any = { APP_TOKEN: "owner", RUNNER_TOKEN: "runner", SANDBOX: {}, ARTIFACTS: { delete: async (key: string) => { deleted.push(key); }, get: async () => null, put: async () => {} } };
  const state: any = { storage, blockConcurrencyWhile: (fn: any) => fn(), waitUntil: () => {} }; const workspace = new Workspace(state, env);
  env.WORKSPACE = { idFromName: () => "owner", get: () => ({ fetch: (request: Request) => workspace.fetch(request) }) };
  return { db, workspace, alarms, deleted };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe("bot transfer lifecycle", () => {
  it("moves queued source success to target delivery and relay cleanup", async () => {
    const f = fixture(); (f.workspace as any).init(); (f.workspace as any).nodes(); const now = new Date(Date.now() + 60000).toISOString(); const manifest = { version: 1, id: "tr_lifecycle", sourceNodeId: "node-a", targetNodeId: "node-b", sourcePath: "a", targetPath: "b", name: "b", size: 0, sha256: "a".repeat(64), objectKey: "transfers/v1/tr_lifecycle", createdAt: new Date().toISOString(), expiresAt: now };
    for (const node of ["node-a", "node-b"]) f.db.prepare("INSERT INTO nodes (id,name,platform,arch,capabilities,secret_hash,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)").run(node, node, "linux", "x", "{}", "x", new Date().toISOString(), new Date().toISOString());
    f.db.prepare("INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?)").run(manifest.id, "key", JSON.stringify(manifest), "up", "down", "queued", new Date().toISOString(), new Date().toISOString());
    f.db.prepare("INSERT INTO node_jobs (id,node_id,status,priority,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("source-job", "node-a", "succeeded", 50, JSON.stringify({ kind: "node.transfer", transfer: manifest, direction: "upload" }), new Date().toISOString(), new Date().toISOString());
    await f.workspace.alarm();
    expect((f.db.prepare("SELECT status FROM transfers WHERE id=?").get(manifest.id) as any)?.status).toBe("delivering");
    f.db.prepare("UPDATE node_jobs SET status='succeeded' WHERE node_id='node-b'").run();
    await f.workspace.alarm();
    expect((f.db.prepare("SELECT status FROM transfers WHERE id=?").get(manifest.id) as any)?.status).toBe("completed");
    expect(f.deleted).toContain(`transfers/v1/${manifest.id}`);
  });
});
