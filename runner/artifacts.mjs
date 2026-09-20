import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { listWorkspaceArtifacts, resolveWorkspaceFile, resolveWorkspacePath, WorkspacePathError } from "../packages/browser/src/index.ts";

export const MAX_ARTIFACT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Handle the runner's small, authenticated artifact surface.
 *
 * Returns true when the URL belongs to this surface and false when the caller
 * should continue routing. Authentication is deliberately left to
 * runner/server.mjs so this module cannot accidentally create an unauthenticated
 * file endpoint when embedded elsewhere.
 */
export async function dispatchArtifactRequest(req, res, workspace, options = {}) {
  const maxUploadBytes = options.maxUploadBytes ?? MAX_ARTIFACT_UPLOAD_BYTES;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_ARTIFACT_DOWNLOAD_BYTES;
  const requestUrl = new URL(req.url ?? "/", "http://runner");
  if (requestUrl.pathname !== "/files" && requestUrl.pathname !== "/files/content") return false;

  try {
    if (requestUrl.pathname === "/files" && req.method === "GET") {
      const requested = artifactPath(requestUrl.searchParams.get("path"), { allowRoot: true });
      const limit = parseLimit(requestUrl.searchParams.get("limit"));
      const artifacts = (await listWorkspaceArtifacts(workspace, requested || ".", limit)).filter((item) =>
        item.path.split(/[\\/]+/).every((segment) => segment && !segment.startsWith("."))
      );
      return json(res, 200, { root: workspace, artifacts });
    }
    if (requestUrl.pathname === "/files/content" && req.method === "GET") {
      const requested = artifactPath(requestUrl.searchParams.get("path"));
      const file = await resolveWorkspaceFile(workspace, requested);
      const info = await lstat(file);
      if (info.size > maxDownloadBytes) return json(res, 413, { error: "artifact exceeds download limit" });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(info.size),
        "content-disposition": `attachment; filename="${safeFilename(path.basename(file))}"`,
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(res);
      return true;
    }
    if (requestUrl.pathname === "/files" && req.method === "POST") {
      const requested = artifactPath(requestUrl.searchParams.get("path"));
      const target = resolveWorkspacePath(workspace, requested);
      await ensureWritableTarget(workspace, target);
      const result = await atomicUpload(req, target, maxUploadBytes);
      return json(res, 201, { path: path.relative(path.resolve(workspace), target), bytes: result.bytes });
    }
    return json(res, 405, { error: "method not allowed" });
  } catch (error) {
    const status = error instanceof WorkspacePathError ? 400 : error?.code === "ENOENT" ? 404 : error?.statusCode ?? 500;
    return json(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
}

function artifactPath(value, { allowRoot = false } = {}) {
  if (value === "." && allowRoot) return ".";
  if (value === null || value === "") {
    if (allowRoot) return ".";
    throw new WorkspacePathError("path query parameter is required");
  }
  if (path.isAbsolute(value)) throw new WorkspacePathError("Absolute paths are not allowed");
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === ".." || segment === "." || segment.startsWith("."))) {
    throw new WorkspacePathError("dot and hidden paths are not allowed");
  }
  return segments.join(path.sep);
}

function parseLimit(value) {
  if (value === null || value === "") return 500;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new WorkspacePathError("limit must be between 1 and 10000");
  return limit;
}

async function ensureWritableTarget(workspace, target) {
  const root = path.resolve(workspace);
  const parent = path.dirname(target);
  resolveWorkspacePath(root, path.relative(root, parent) || ".");
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new WorkspacePathError("artifact parent is not a directory");
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) throw new WorkspacePathError("cannot overwrite a symbolic link");
    if (existing.isDirectory()) throw new WorkspacePathError("artifact target is a directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function atomicUpload(req, target, maxBytes) {
  const temp = `${target}.upload-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let bytes = 0;
  const stream = createWriteStream(temp, { flags: "wx", mode: 0o600 });
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        req.destroy();
        throw Object.assign(new Error("artifact exceeds upload limit"), { statusCode: 413 });
      }
      if (!stream.write(chunk)) await onceDrain(stream);
    }
    await new Promise((resolve, reject) => { stream.end((error) => error ? reject(error) : resolve()); });
    await rename(temp, target);
    return { bytes };
  } catch (error) {
    stream.destroy();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

function json(res, status, body) {
  if (res.headersSent) return true;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}
