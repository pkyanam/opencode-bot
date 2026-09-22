import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { link, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MAX_TRANSFER_INGEST_BYTES = 512 * 1024 * 1024;

export async function ingestTransfer(req, res, workspace, limits = {}) {
  const url = new URL(req.url ?? "/", "http://runner");
  if (url.pathname !== "/files/transfer" || req.method !== "POST") return false;
  const maxBytes = limits.maxBytes ?? MAX_TRANSFER_INGEST_BYTES;
  try {
    const relative = url.searchParams.get("path");
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw error(400, "transfer path must be workspace-relative");
    const root = path.resolve(workspace); const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw error(400, "transfer path escapes workspace");
    await ensureParents(root, path.dirname(target)); await safePath(root, target, true);
    const expectedHash = req.headers["x-transfer-sha256"]; const expectedSize = Number(req.headers["x-transfer-size"]);
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) throw error(400, "transfer digest and size headers are required");
    if (await exists(target)) throw error(409, "destination already exists");
    const temp = `${target}.transfer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let bytes = 0; const hash = createHash("sha256");
    const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > expectedSize || bytes > maxBytes) return callback(error(413, "transfer exceeds manifest size")); hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(req, meter, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
      if (bytes !== expectedSize || hash.digest("hex") !== expectedHash) throw error(422, "transfer integrity check failed");
      try { await link(temp, target); } catch (linkError) { if (linkError.code === "EEXIST") throw error(409, "destination already exists"); throw linkError; }
      await unlink(temp); return json(res, 201, { path: relative, bytes, sha256: expectedHash });
    } catch (failure) { await unlink(temp).catch(() => undefined); throw failure; }
  } catch (failure) { return json(res, failure.statusCode ?? 500, { error: failure.message ?? String(failure) }); }
}

async function safePath(root, target, allowMissing) { let current = root; if ((await lstat(root)).isSymbolicLink()) throw error(400, "workspace root is unsafe"); for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if ((await lstat(current)).isSymbolicLink()) throw error(400, "symbolic links are not allowed"); } catch (failure) { if (failure.code === "ENOENT" && allowMissing && current === target) return; throw failure; } } }
async function ensureParents(root, target) { const parts = path.relative(root, target).split(path.sep).filter(Boolean); let current = root; for (const part of parts) { current = path.join(current, part); if (await exists(current)) { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw error(400, "unsafe transfer parent"); } else await mkdir(current); } }
async function exists(target) { try { await lstat(target); return true; } catch (failure) { if (failure.code === "ENOENT") return false; throw failure; } }
function error(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; }
