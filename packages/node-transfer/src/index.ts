/**
 * Version one of node-to-node transfer is an authenticated R2 relay.
 *
 * This package deliberately contains no filesystem access and no outbound
 * fetch. The node agent owns path resolution and streams bytes to the control
 * worker; the worker only sees a validated relative workspace path and an R2
 * object key. A future direct transport can implement the same manifest and
 * authorization contract.
 */

export type TransferDirection = "upload" | "download";

export type TransferManifest = {
  version: 1;
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePath: string;
  targetPath: string;
  name: string;
  size: number;
  sha256: string;
  objectKey: string;
  createdAt: string;
  expiresAt: string;
};

export type TransferLimits = {
  maxBytes: number;
  maxTtlMs: number;
  defaultTtlMs: number;
};

export type TransferSigner = {
  /** Secret stays in the control plane; it is never returned to either node. */
  sign(value: string): Promise<string>;
  verify(value: string, signature: string): Promise<boolean>;
};

export type TransferStoreObject = {
  body: ReadableStream<Uint8Array> | null;
  size?: number;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
};

export type TransferStore = {
  put(key: string, body: ReadableStream<Uint8Array>, options: {
    size: number;
    httpMetadata?: { contentType?: string; contentDisposition?: string };
    customMetadata?: Record<string, string>;
  }): Promise<void>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<TransferStoreObject | null>;
  delete?(key: string): Promise<void>;
};

export class TransferError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "transfer_error") {
    super(message);
    this.name = "TransferError";
  }
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxTtlMs: 30 * 60 * 1000,
  defaultTtlMs: 10 * 60 * 1000,
};

const SHA256 = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME = 160;

/** Validate a workspace-relative path without ever resolving it on a host. */
export function assertWorkspacePath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0"))
    throw new TransferError(400, `${field} must be a workspace-relative path`, "invalid_path");
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value))
    throw new TransferError(400, `${field} must be workspace-relative`, "invalid_path");
  // Backslashes are rejected rather than normalized, preventing platform
  // dependent traversal when an agent runs on Windows.
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "" || part === "." || part.includes(":")))
    throw new TransferError(400, `${field} contains an unsafe path segment`, "invalid_path");
  return value;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64urlText(value: string): string { return base64url(text(value)); }
function decodeBase64urlText(value: string): string { return new TextDecoder().decode(fromBase64url(value)); }

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const asBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", asBuffer(text(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, asBuffer(text(value))));
}

/** HMAC signer suitable for a per-workspace control-plane secret. */
export function hmacSigner(secret: string): TransferSigner {
  return {
    async sign(value) { return base64url(await hmac(secret, value)); },
    async verify(value, signature) {
      if (!/^[A-Za-z0-9_-]+$/.test(signature)) return false;
      const expected = await hmac(secret, value);
      const actual = fromBase64url(signature);
      if (expected.length !== actual.length) return false;
      let difference = 0;
      for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
      return difference === 0;
    },
  };
}

function id(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `tr_${base64url(bytes)}`;
}

function safeName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_NAME || value.includes("\0") || value.includes("/") || value.includes("\\"))
    throw new TransferError(400, "name is invalid", "invalid_name");
  return value;
}

export function createTransferManifest(input: {
  sourceNodeId: string;
  targetNodeId: string;
  sourcePath: string;
  targetPath: string;
  name: string;
  size: number;
  sha256: string;
  ttlMs?: number;
  now?: Date;
  limits?: Partial<TransferLimits>;
  transferId?: string;
}): TransferManifest {
  const limits = { ...DEFAULT_TRANSFER_LIMITS, ...input.limits };
  if (!NODE_ID.test(input.sourceNodeId) || !NODE_ID.test(input.targetNodeId)) throw new TransferError(400, "node id is invalid", "invalid_node");
  const sourcePath = assertWorkspacePath(input.sourcePath, "sourcePath");
  const targetPath = assertWorkspacePath(input.targetPath, "targetPath");
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxBytes) throw new TransferError(413, "file exceeds transfer limit", "size_limit");
  if (!SHA256.test(input.sha256)) throw new TransferError(400, "sha256 must be a lowercase SHA-256 digest", "invalid_digest");
  const ttl = input.ttlMs ?? limits.defaultTtlMs;
  if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > limits.maxTtlMs) throw new TransferError(400, "transfer expiry is invalid", "invalid_expiry");
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const transferId = input.transferId ?? id();
  return { version: 1, id: transferId, sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId, sourcePath, targetPath, name: safeName(input.name), size, sha256: input.sha256, objectKey: `transfers/v1/${transferId}`, createdAt, expiresAt: new Date(now.getTime() + ttl).toISOString() };
}

/** Sign only a transfer id and node-bound direction; manifest remains server-side. */
export async function issueTransferToken(manifest: TransferManifest, direction: TransferDirection, signer: TransferSigner): Promise<string> {
  const claims = `${manifest.id}.${direction}.${manifest.expiresAt}`;
  return `${base64urlText(claims)}.${await signer.sign(claims)}`;
}

export async function verifyTransferToken(token: string, manifest: TransferManifest, direction: TransferDirection, signer: TransferSigner, now = new Date()): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  let claims: string;
  try { claims = decodeBase64urlText(parts[0]); } catch { return false; }
  const claimParts = claims.split(".");
  const claimExpiry = claimParts.slice(2).join(".");
  if (claimParts.length < 3 || claimParts[0] !== manifest.id || claimParts[1] !== direction || claimExpiry !== manifest.expiresAt || Date.parse(manifest.expiresAt) <= now.getTime()) return false;
  return signer.verify(claims, parts[1]);
}

export function transferObjectKey(manifest: TransferManifest): string {
  return `transfers/v1/${manifest.id}`;
}

/** Build an upload request with streaming bytes; callers must not convert to JSON/base64. */
export function uploadRequest(manifest: TransferManifest, token: string, body: ReadableStream<Uint8Array>, contentType = "application/octet-stream", baseUrl = "https://transfer.invalid"): Request {
  return new Request(`${baseUrl.replace(/\/$/, "")}/api/transfers/${encodeURIComponent(manifest.id)}/content`, { method: "PUT", body, headers: { authorization: `Bearer ${token}`, "content-type": contentType, "content-length": String(manifest.size), "x-transfer-sha256": manifest.sha256 } });
}

/** Build a resumable ranged download request. */
export function downloadRequest(manifest: TransferManifest, token: string, range?: { start: number; end?: number }, baseUrl = "https://transfer.invalid"): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (range) {
    if (!Number.isSafeInteger(range.start) || range.start < 0 || (range.end !== undefined && range.end < range.start)) throw new TransferError(416, "invalid range", "invalid_range");
    headers.set("range", `bytes=${range.start}-${range.end ?? ""}`);
  }
  return new Request(`${baseUrl.replace(/\/$/, "")}/api/transfers/${encodeURIComponent(manifest.id)}/content`, { method: "GET", headers });
}

export async function boundedStream(body: ReadableStream<Uint8Array>, expectedSize: number, maxBytes: number): Promise<ReadableStream<Uint8Array>> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) throw new TransferError(413, "file exceeds transfer limit", "size_limit");
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      const item = await reader.read();
      if (item.done) {
        if (total !== expectedSize) { controller.error(new TransferError(400, "content length does not match manifest", "size_mismatch")); return; }
        controller.close(); return;
      }
      total += item.value.byteLength;
      if (total > expectedSize || total > maxBytes) { await reader.cancel(); controller.error(new TransferError(413, "file exceeds transfer limit", "size_limit")); return; }
      controller.enqueue(item.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export type TransferProtocol = ReturnType<typeof createTransferProtocol>;

/** R2 relay adapter. Node authentication is supplied by the existing NodeRegistry. */
export function createTransferProtocol(options: { store: TransferStore; signer: TransferSigner; limits?: Partial<TransferLimits>; now?: () => Date; verifyUploadDigest?: (body: ReadableStream<Uint8Array>, expectedSha256: string) => Promise<void> }) {
  const limits = { ...DEFAULT_TRANSFER_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  return {
    limits,
    async authorize(manifest: TransferManifest, token: string, direction: TransferDirection) {
      return verifyTransferToken(token, manifest, direction, options.signer, now());
    },
    async put(manifest: TransferManifest, token: string, body: ReadableStream<Uint8Array>, contentType = "application/octet-stream") {
      if (!(await verifyTransferToken(token, manifest, "upload", options.signer, now()))) throw new TransferError(401, "invalid or expired transfer token", "invalid_token");
      const bounded = await boundedStream(body, manifest.size, limits.maxBytes);
      let uploadBody = bounded;
      if (options.verifyUploadDigest) {
        const [toStore, toHash] = bounded.tee();
        uploadBody = toStore;
        await options.verifyUploadDigest(toHash, manifest.sha256);
      }
      await options.store.put(transferObjectKey(manifest), uploadBody, { size: manifest.size, httpMetadata: { contentType }, customMetadata: { transferId: manifest.id, sha256: manifest.sha256, size: String(manifest.size), expiresAt: manifest.expiresAt, sourceNodeId: manifest.sourceNodeId, targetNodeId: manifest.targetNodeId } });
    },
    async get(manifest: TransferManifest, token: string, range?: { offset: number; length: number }) {
      if (!(await verifyTransferToken(token, manifest, "download", options.signer, now()))) throw new TransferError(401, "invalid or expired transfer token", "invalid_token");
      if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length <= 0 || range.offset + range.length > manifest.size)) throw new TransferError(416, "invalid range", "invalid_range");
      const object = await options.store.get(transferObjectKey(manifest), range ? { range } : undefined);
      if (!object?.body) throw new TransferError(404, "transfer content is not available", "not_found");
      if (object.customMetadata?.transferId !== manifest.id || object.customMetadata?.sha256 !== manifest.sha256 || object.customMetadata?.size !== String(manifest.size))
        throw new TransferError(502, "stored transfer metadata failed integrity checks", "integrity_mismatch");
      return object;
    },
    async delete(manifest: TransferManifest) {
      if (options.store.delete) await options.store.delete(transferObjectKey(manifest));
    },
  };
}
