/** Explicit whole-computer filesystem surface. Callers must opt into scope=computer. */
import { constants, createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, unlink, link, readFile, open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MAX_COMPUTER_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_COMPUTER_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_RUNTIME_FILE_READ_BYTES = 150 * 1024;

/** JSON-sized node admin bridge for metadata and small reads. Large content uses /files/content. */
export async function computerFileOperation(operation, input = {}) {
  if (input.scope !== "computer") throw pathError("scope=computer is required");
  if (operation === "file_list") {
    const target = absolutePath(input.path); const info = await lstat(target); if (info.isSymbolicLink()) throw pathError("symbolic links are not allowed");
    return { scope: "computer", root: target, artifacts: info.isDirectory() ? await list(target, boundedLimit(input.limit), input.recursive === true) : [{ path: target, kind: "file", size: info.size }] };
  }
  if (operation === "file_read") {
    const target = absolutePath(input.path); await rejectSymlink(target); const info = await lstat(target);
    if (!info.isFile()) throw pathError("path is not a file");
    if (info.size > MAX_RUNTIME_FILE_READ_BYTES) throw Object.assign(new Error("file exceeds JSON read limit; use streamed file content"), { statusCode: 413 });
    return { scope: "computer", path: target, contentBase64: (await readFile(target)).toString("base64"), size: info.size };
  }
  if (operation === "file_stat") {
    const target = absolutePath(input.path); const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw pathError("path is not a file");
      if (info.size > MAX_COMPUTER_UPLOAD_BYTES) throw Object.assign(new Error("file exceeds relay limit"), { statusCode: 413 });
      const hash = createHash("sha256"); let bytes = 0;
      if (info.size > 0) for await (const chunk of handle.createReadStream({ start: 0, end: info.size - 1 })) { bytes += chunk.length; hash.update(chunk); }
      return { scope: "computer", path: target, name: path.basename(target), size: bytes, sha256: hash.digest("hex") };
    } finally { await handle.close(); }
  }
  if (operation === "file_mkdir") { const target = absolutePath(input.path); await ensureParents(target); await rejectSymlink(target, true); await mkdir(target, { mode: 0o700 }); return { scope: "computer", path: target, kind: "directory" }; }
  if (operation === "file_move") { const source = absolutePath(input.from); const target = absolutePath(input.to); if (source === target) throw pathError("source and destination must differ"); await rejectSymlink(source); await ensureParents(target); await rejectSymlink(target, true); if (await exists(target)) throw pathError("destination already exists"); await rename(source, target); return { scope: "computer", from: source, to: target }; }
  if (operation === "file_delete") { const target = absolutePath(input.path); if (target === path.parse(target).root) throw pathError("filesystem root cannot be deleted"); await rejectSymlink(target); const info = await lstat(target); await rm(target, { recursive: info.isDirectory() }); return { scope: "computer", deleted: true, path: target }; }
  throw pathError("unsupported computer file operation");
}

export async function dispatchComputerFileRequest(req, res, options = {}) {
  const url = new URL(req.url ?? "/", "http://runner");
  if (url.searchParams.get("scope") !== "computer") return false;
  if (!["/files", "/files/content", "/files/mkdir", "/files/move"].includes(url.pathname)) return false;
  const maxUploadBytes = options.maxUploadBytes ?? MAX_COMPUTER_UPLOAD_BYTES;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_COMPUTER_DOWNLOAD_BYTES;
  try {
    if (url.pathname === "/files" && req.method === "GET") {
      const target = absolutePath(url.searchParams.get("path"));
      const limit = boundedLimit(url.searchParams.get("limit"));
      const info = await lstat(target); if (info.isSymbolicLink()) throw pathError("symbolic links are not allowed");
      const entries = info.isDirectory() ? await list(target, limit, url.searchParams.get("recursive") === "true") : [{ path: target, kind: "file", size: info.size }];
      return json(res, 200, { scope: "computer", root: target, artifacts: entries });
    }
    if (url.pathname === "/files/content" && req.method === "GET") {
      const target = absolutePath(url.searchParams.get("path")); await rejectSymlink(target);
      const info = await lstat(target); if (!info.isFile()) throw pathError("path is not a file");
      if (info.size > maxDownloadBytes) return json(res, 413, { error: "file exceeds download limit" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(info.size), "content-disposition": `attachment; filename="${safeFilename(path.basename(target))}"`, "cache-control": "no-store" });
      await pipeline(createReadStream(target), res); return true;
    }
    if (url.pathname === "/files/mkdir" && req.method === "POST") {
      const target = absolutePath(url.searchParams.get("path")); await ensureParents(target); await rejectSymlink(target, true);
      await mkdir(target, { mode: 0o700 }); return json(res, 201, { scope: "computer", path: target, kind: "directory" });
    }
    if (url.pathname === "/files/move" && req.method === "POST") {
      const source = absolutePath(url.searchParams.get("from")); const target = absolutePath(url.searchParams.get("to"));
      if (source === target) throw pathError("source and destination must differ"); await rejectSymlink(source); await ensureParents(target); await rejectSymlink(target, true);
      if (await exists(target)) throw pathError("destination already exists"); await rename(source, target); return json(res, 200, { scope: "computer", from: source, to: target });
    }
    if (url.pathname === "/files" && req.method === "DELETE") {
      const target = absolutePath(url.searchParams.get("path")); if (target === path.parse(target).root) throw pathError("filesystem root cannot be deleted"); await rejectSymlink(target);
      const info = await lstat(target); await rm(target, { recursive: info.isDirectory() }); return json(res, 200, { scope: "computer", deleted: true, path: target });
    }
    if (url.pathname === "/files" && req.method === "POST") {
      const target = absolutePath(url.searchParams.get("path")); await ensureParents(target); await rejectSymlink(target, true);
      const bytes = await atomicUpload(req, target, maxUploadBytes, url.searchParams.get("overwrite") === "true"); return json(res, 201, { scope: "computer", path: target, bytes });
    }
    return json(res, 405, { error: "method not allowed" });
  } catch (error) { const status = error?.statusCode ?? (error?.code === "ENOENT" ? 404 : error?.code === "EEXIST" ? 409 : 400); return json(res, status, { error: error instanceof Error ? error.message : String(error) }); }
}

function absolutePath(value) { if (typeof value !== "string" || !value || !path.isAbsolute(value) || value.includes("\0")) throw pathError("scope=computer requires an absolute path"); return path.normalize(value); }
function pathError(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
async function exists(value) { try { await lstat(value); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function rejectSymlink(target, allowMissing = false) { let current = path.parse(target).root; for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if ((await lstat(current)).isSymbolicLink()) throw pathError("symbolic links are not allowed"); } catch (error) { if (error.code === "ENOENT" && allowMissing && current === target) return; throw error; } } }
async function ensureParents(target) { const parent = path.dirname(target); const segments = path.relative(path.parse(parent).root, parent).split(path.sep).filter(Boolean); let current = path.parse(parent).root; for (const segment of segments) { current = path.join(current, segment); if (await exists(current)) { await rejectSymlink(current); if (!(await lstat(current)).isDirectory()) throw pathError("parent is not a directory"); } else await mkdir(current); } }
async function list(root, limit, recursive = false) { const result = []; const queue = [root]; while (queue.length && result.length < limit) { const current = queue.shift(); let names; try { names = await (await import("node:fs/promises")).readdir(current); } catch (error) { result.push({ path: current, kind: "directory", error: error.code === "EACCES" ? "permission denied" : "could not read directory" }); continue; } for (const name of names) { if (result.length >= limit) break; const target = path.join(current, name); try { const info = await lstat(target); const item = { path: target, kind: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file", ...(info.isFile() ? { size: info.size } : {}) }; result.push(item); if (recursive && info.isDirectory() && !info.isSymbolicLink()) queue.push(target); } catch (error) { result.push({ path: target, kind: "unknown", error: error.code === "EACCES" ? "permission denied" : "could not inspect entry" }); } } } return result; }
function boundedLimit(value) { const limit = value == null ? 500 : Number(value); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw pathError("limit must be between 1 and 10000"); return limit; }
async function atomicUpload(req, target, maxBytes, overwrite) { const temp = `${target}.upload-${process.pid}-${Math.random().toString(16).slice(2)}`; let bytes = 0; const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > maxBytes) return callback(Object.assign(new Error("file exceeds upload limit"), { statusCode: 413 })); callback(null, chunk); } }); try { await pipeline(req, meter, createWriteStream(temp, { flags: "wx", mode: 0o600 })); if (overwrite) await rename(temp, target); else { await link(temp, target); await unlink(temp); } return bytes; } catch (error) { await unlink(temp).catch(() => undefined); throw error; } }
function safeFilename(value) { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file"; }
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; }
