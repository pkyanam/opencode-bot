/** Bounded, explicit R2 storage accounting and checkpoint retention helpers. */

export type StorageObject = {
  key: string;
  size: number;
  uploaded?: string | Date;
  customMetadata?: Record<string, string>;
};

export type StorageBucket = {
  list(options?: { cursor?: string; limit?: number }): Promise<{
    objects: StorageObject[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown>;
};

export type StorageUsage = {
  checkpointPrefix: string;
  observedObjects: number;
  observedBytes: number;
  checkpointObjects: number;
  checkpointBytes: number;
  otherObjects: number;
  otherBytes: number;
  pages: number;
  truncated: boolean;
};

export type StorageObjectView = StorageObject & {
  category: "checkpoint" | "artifact" | "other";
  protected: boolean;
};

export type StorageListing = {
  objects: StorageObjectView[];
  totals: { bytes: number; checkpointBytes: number; otherBytes: number; objects: number };
  truncated: boolean;
};

export type RetentionPlan = {
  keep: StorageObject[];
  delete: StorageObject[];
  protectedKeys: string[];
  projectedCheckpointBytes: number;
};

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_KEEP_CHECKPOINTS = 2;
const DEFAULT_MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024 * 1024;

function checkpointKey(key: string, prefix: string): boolean {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  return key.startsWith(`${normalized}/`) && key.endsWith(".tar.gz");
}

function objectDate(object: StorageObject): number {
  const value = object.uploaded === undefined ? 0 : new Date(object.uploaded).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** List bounded bucket pages and report whether accounting is complete. */
export async function measureStorageUsage(
  bucket: StorageBucket,
  options: { checkpointPrefix?: string; pageSize?: number; maxPages?: number } = {},
): Promise<StorageUsage> {
  const checkpointPrefix = options.checkpointPrefix ?? "checkpoints";
  const pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  let cursor: string | undefined;
  let pages = 0;
  let observedObjects = 0;
  let observedBytes = 0;
  let checkpointObjects = 0;
  let checkpointBytes = 0;
  let truncated = false;
  do {
    const page = await bucket.list({ ...(cursor ? { cursor } : {}), limit: pageSize });
    pages += 1;
    for (const object of page.objects) {
      const size = Number.isFinite(object.size) && object.size >= 0 ? object.size : 0;
      observedObjects += 1;
      observedBytes += size;
      if (checkpointKey(object.key, checkpointPrefix)) {
        checkpointObjects += 1;
        checkpointBytes += size;
      }
    }
    if (!page.truncated) break;
    if (pages >= maxPages || !page.cursor) { truncated = true; break; }
    cursor = page.cursor;
  } while (true);
  return { checkpointPrefix, observedObjects, observedBytes, checkpointObjects, checkpointBytes, otherObjects: observedObjects - checkpointObjects, otherBytes: observedBytes - checkpointBytes, pages, truncated };
}

/** Return bounded object metadata for a storage-management UI. */
export async function listStorageObjects(
  bucket: StorageBucket,
  options: { checkpointPrefix?: string; protectedKeys?: Iterable<string>; pageSize?: number; maxPages?: number; maxObjects?: number } = {},
): Promise<StorageListing> {
  const checkpointPrefix = options.checkpointPrefix ?? "checkpoints";
  const protectedKeys = new Set(options.protectedKeys ?? []);
  const pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  const maxObjects = Math.max(1, Math.floor(options.maxObjects ?? 5000));
  const objects: StorageObjectView[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  do {
    const page = await bucket.list({ ...(cursor ? { cursor } : {}), limit: Math.min(pageSize, maxObjects - objects.length) });
    pages += 1;
    for (const object of page.objects) {
      if (objects.length >= maxObjects) { truncated = true; break; }
      const checkpoint = checkpointKey(object.key, checkpointPrefix);
      objects.push({ ...object, category: checkpoint ? "checkpoint" : object.key.startsWith("uploads/") ? "artifact" : "other", protected: protectedKeys.has(object.key) });
    }
    if (objects.length >= maxObjects) { truncated = page.truncated; break; }
    if (!page.truncated) break;
    if (pages >= maxPages || !page.cursor) { truncated = true; break; }
    cursor = page.cursor;
  } while (true);
  const checkpointBytes = objects.filter((object) => object.category === "checkpoint").reduce((sum, object) => sum + object.size, 0);
  const bytes = objects.reduce((sum, object) => sum + object.size, 0);
  return { objects, totals: { bytes, checkpointBytes, otherBytes: bytes - checkpointBytes, objects: objects.length }, truncated };
}

/** Build a deletion proposal. This function has no storage side effects. */
export function planCheckpointRetention(
  objects: readonly StorageObject[],
  options: { checkpointPrefix?: string; keep?: number; maxBytes?: number; protectedKeys?: Iterable<string> } = {},
): RetentionPlan {
  const prefix = options.checkpointPrefix ?? "checkpoints";
  const keepCount = Math.max(0, Math.floor(options.keep ?? DEFAULT_KEEP_CHECKPOINTS));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  const protectedKeys = new Set(options.protectedKeys ?? []);
  const checkpoints = objects.filter((object) => checkpointKey(object.key, prefix));
  const ordered = [...checkpoints].sort((a, b) => objectDate(b) - objectDate(a) || b.key.localeCompare(a.key));
  const keepKeys = new Set(ordered.filter((object, index) => protectedKeys.has(object.key) || index < keepCount).map((object) => object.key));
  let bytes = ordered.filter((object) => keepKeys.has(object.key)).reduce((total, object) => total + object.size, 0);
  // Free space by dropping the oldest unprotected candidates first. Protected
  // committed/active checkpoints remain retained even if they exceed the cap.
  for (const object of [...ordered].reverse()) {
    if (bytes <= maxBytes) break;
    if (!keepKeys.has(object.key) || protectedKeys.has(object.key)) continue;
    keepKeys.delete(object.key);
    bytes -= object.size;
  }
  const keep = ordered.filter((object) => keepKeys.has(object.key));
  const deleteObjects = ordered.filter((object) => !keepKeys.has(object.key));
  return { keep, delete: deleteObjects, protectedKeys: [...protectedKeys].sort(), projectedCheckpointBytes: bytes };
}

/** Delete only explicitly selected checkpoint keys after the caller confirms the plan. */
export async function deleteSelectedCheckpointObjects(
  bucket: StorageBucket,
  keys: readonly string[],
  options: { checkpointPrefix?: string; protectedKeys?: Iterable<string> } = {},
): Promise<{ deleted: string[] }> {
  const prefix = options.checkpointPrefix ?? "checkpoints";
  const protectedKeys = new Set(options.protectedKeys ?? []);
  const selected = [...new Set(keys)];
  if (selected.some((key) => !checkpointKey(key, prefix))) throw new Error("Only checkpoint objects may be deleted");
  const blocked = selected.filter((key) => protectedKeys.has(key));
  if (blocked.length) throw new Error(`Protected checkpoint cannot be deleted: ${blocked.join(", ")}`);
  if (!selected.length) return { deleted: [] };
  await bucket.delete(selected);
  return { deleted: selected };
}
