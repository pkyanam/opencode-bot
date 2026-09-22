/** Node-side transfer bridge. Files never enter JSON or memory as one blob. */
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rename, link, stat, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 512 * 1024 * 1024;
const RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function workspacePath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some((part) => part.includes(":"))) throw new Error("transfer path must be workspace-relative");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("transfer path escapes workspace");
  return resolved;
}

async function ensureNoSymlink(root, target, allowMissingLeaf = false) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  let current = resolvedTarget;
  const pending = [];
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${path.sep}`)) { pending.unshift(path.basename(current)); current = path.dirname(current); }
  if (current !== resolvedRoot) throw new Error("transfer path escapes workspace");
  current = resolvedRoot;
  const rootItem = await lstat(current).catch((error) => { throw error; });
  if (rootItem.isSymbolicLink() || !rootItem.isDirectory()) throw new Error("workspace root is unsafe");
  for (let i = 0; i < pending.length; i += 1) {
    current = path.join(current, pending[i]);
    try { const item = await lstat(current); if (item.isSymbolicLink()) throw new Error("symlink paths are not allowed for transfers"); }
    catch (error) { if (error.code === "ENOENT" && allowMissingLeaf && i === pending.length - 1) return; throw error; }
  }
}

export async function safeSource(root, relative) { const target = workspacePath(root, relative); await ensureNoSymlink(root, target); const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const item = await handle.stat(); if (!item.isFile()) { await handle.close(); throw new Error("transfer source must be a regular file"); } await handle.close(); return { target, size: item.size }; }
export async function safeDestination(root, relative, overwrite = false) {
  const target = workspacePath(root, relative); const parent = path.dirname(target); const resolvedRoot = path.resolve(root);
  await ensureNoSymlink(root, resolvedRoot);
  const segments = path.relative(resolvedRoot, parent).split(path.sep).filter(Boolean); let current = resolvedRoot;
  for (const segment of segments) { current = path.join(current, segment); try { const item = await lstat(current); if (item.isSymbolicLink() || !item.isDirectory()) throw new Error("destination parent is unsafe"); } catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(current); } }
  await ensureNoSymlink(root, target, true);
  if (!overwrite) await access(target).then(() => { throw new Error("destination already exists"); }).catch((error) => { if (error.code !== "ENOENT") throw error; });
  return target;
}

export async function sha256File(file, maxBytes = MAX_BYTES) {
  const digest = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; if (size > maxBytes) throw new Error("transfer file exceeds size limit"); digest.update(chunk); }
  return { size, sha256: digest.digest("hex") };
}

async function hashOpenFile(file, maxBytes = MAX_BYTES) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const digest = createHash("sha256"); let size = 0; for await (const chunk of createReadStream(null, { fd: handle.fd, autoClose: false })) { size += chunk.length; if (size > maxBytes) throw new Error("transfer file exceeds size limit"); digest.update(chunk); } return { size, sha256: digest.digest("hex") }; } finally { await handle.close(); }
}

async function hashHandle(handle, maxBytes = MAX_BYTES) {
  const digest = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(null, { fd: handle.fd, autoClose: false, start: 0 })) { size += chunk.length; if (size > maxBytes) throw new Error("transfer file exceeds size limit"); digest.update(chunk); }
  return { size, sha256: digest.digest("hex") };
}

function retryable(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }

export async function uploadFile({ baseUrl, token, manifest, sourceRoot, fetcher = fetch, retries = RETRIES, timeoutMs = 120_000 }) {
  const { target, size } = await safeSource(sourceRoot, manifest.sourcePath);
  const sourceHandle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await sourceHandle.stat();
    if (!initial.isFile() || initial.size !== size) throw new Error("source is not a stable regular file");
    const actual = await hashHandle(sourceHandle);
    const afterHash = await sourceHandle.stat();
    if (afterHash.size !== initial.size || actual.size !== manifest.size || actual.sha256 !== manifest.sha256) throw new Error("source changed or manifest digest does not match");
    let last;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
      const body = Readable.toWeb(createReadStream(null, { fd: sourceHandle.fd, autoClose: false, start: 0 }));
      const response = await fetcher(`${String(baseUrl).replace(/\/$/, "")}/api/transfers/${encodeURIComponent(manifest.id)}/content`, { method: "PUT", body, duplex: "half", signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(size), "x-transfer-sha256": manifest.sha256 } });
      if (response.ok) return response;
      last = new Error(`transfer upload failed (${response.status})`); last.retryable = retryable(response.status); if (!last.retryable) throw last;
      } catch (error) { last = error; if (error.retryable === false || attempt === retries) throw error; error.retryable = true; }
      await sleep(200 * (2 ** attempt));
    }
    throw last;
  } finally { await sourceHandle.close(); }
}

export async function downloadFile({ baseUrl, token, manifest, destinationRoot, overwrite = false, fetcher = fetch, retries = RETRIES, timeoutMs = 120_000 }) {
  const target = await safeDestination(destinationRoot, manifest.targetPath, overwrite);
  let last;
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const temp = `${target}.transfer-${process.pid}-${Date.now()}-${attempt}`;
      let handle;
      try {
        const response = await fetcher(`${String(baseUrl).replace(/\/$/, "")}/api/transfers/${encodeURIComponent(manifest.id)}/content`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok || !response.body) { last = new Error(`transfer download failed (${response.status})`); last.retryable = retryable(response.status); if (!last.retryable) throw last; }
        else {
          handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          const digest = createHash("sha256"); let size = 0;
          const meter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > manifest.size || size > MAX_BYTES) return callback(new Error("download exceeds manifest size")); digest.update(chunk); callback(null, chunk); } });
          await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(null, { fd: handle.fd, autoClose: false })); await handle.close(); handle = undefined;
          const actual = digest.digest("hex");
          if (size !== manifest.size || actual !== manifest.sha256) throw new Error("download integrity check failed");
          if (overwrite) await rename(temp, target);
          else { try { await link(temp, target); await rm(temp, { force: true }); } catch (error) { if (error.code === "EEXIST") throw new Error("destination appeared during transfer"); throw error; } }
          return target;
        }
      } catch (error) { if (handle) await handle.close().catch(() => undefined); last = error; if (error.retryable === false || /integrity|exceeds|destination appeared|unsafe/.test(String(error.message)) || attempt === retries) throw error; error.retryable = true; }
      await rm(temp, { force: true });
      await sleep(200 * (2 ** attempt));
    }
    throw last;
  } catch (error) { throw error; }
}

export async function transferFile(input) { return input.direction === "upload" ? uploadFile(input) : downloadFile(input); }
