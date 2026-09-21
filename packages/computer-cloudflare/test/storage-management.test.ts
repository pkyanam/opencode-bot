import { describe, expect, it } from "vitest";
import { deleteSelectedCheckpointObjects, measureStorageUsage, planCheckpointRetention, type StorageObject } from "../src/storage-management.js";

const checkpoint = (key: string, size: number, uploaded: string): StorageObject => ({ key, size, uploaded });

describe("checkpoint storage management", () => {
  it("accounts for bounded pages and reports truncation truthfully", async () => {
    const calls: unknown[] = [];
    const bucket = {
      list: async (options: unknown) => {
        calls.push(options);
        return calls.length === 1
          ? { objects: [checkpoint("checkpoints/a.tar.gz", 10, "2026-01-01"), { key: "uploads/a", size: 3 }], truncated: true, cursor: "next" }
          : { objects: [checkpoint("checkpoints/b.tar.gz", 20, "2026-01-02")], truncated: true, cursor: "more" };
      },
      delete: async () => undefined,
    };
    await expect(measureStorageUsage(bucket, { pageSize: 2, maxPages: 2 })).resolves.toEqual({ checkpointPrefix: "checkpoints", observedObjects: 3, observedBytes: 33, checkpointObjects: 2, checkpointBytes: 30, otherObjects: 1, otherBytes: 3, pages: 2, truncated: true });
  });

  it("preserves protected committed and active checkpoints while applying count and byte retention", () => {
    const objects = [
      checkpoint("checkpoints/old.tar.gz", 90, "2026-01-01"),
      checkpoint("checkpoints/active.tar.gz", 90, "2026-01-02"),
      checkpoint("checkpoints/new.tar.gz", 90, "2026-01-03"),
      { key: "uploads/user.bin", size: 500 },
    ];
    const plan = planCheckpointRetention(objects, { keep: 2, maxBytes: 100, protectedKeys: ["checkpoints/active.tar.gz"] });
    expect(plan.keep.map((object) => object.key)).toEqual(["checkpoints/active.tar.gz"]);
    expect(plan.delete.map((object) => object.key)).toEqual(["checkpoints/new.tar.gz", "checkpoints/old.tar.gz"]);
    expect(plan.projectedCheckpointBytes).toBe(90);
  });

  it("requires explicit checkpoint-only deletion and blocks protected keys", async () => {
    const deleted: string[][] = [];
    const bucket = { list: async () => ({ objects: [], truncated: false }), delete: async (keys: string | string[]) => deleted.push(Array.isArray(keys) ? keys : [keys]) };
    await expect(deleteSelectedCheckpointObjects(bucket, ["uploads/user.bin"])).rejects.toThrow("Only checkpoint objects");
    await expect(deleteSelectedCheckpointObjects(bucket, ["checkpoints/active.tar.gz"], { protectedKeys: ["checkpoints/active.tar.gz"] })).rejects.toThrow("Protected checkpoint");
    await expect(deleteSelectedCheckpointObjects(bucket, ["checkpoints/old.tar.gz"])).resolves.toEqual({ deleted: ["checkpoints/old.tar.gz"] });
    expect(deleted).toEqual([["checkpoints/old.tar.gz"]]);
  });
});
