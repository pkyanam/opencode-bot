import { describe, expect, it } from "vitest";
import {
  TransferError, assertWorkspacePath, boundedStream, createTransferManifest,
  createTransferProtocol, hmacSigner, issueTransferToken, transferObjectKey,
} from "./index";

const digest = "a".repeat(64);
const base = { sourceNodeId: "node_a", targetNodeId: "node_b", sourcePath: "projects/a.bin", targetPath: "incoming/a.bin", name: "a.bin", size: 3, sha256: digest, now: new Date("2026-01-01T00:00:00.000Z") };

function stream(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { const encoder = new TextEncoder(); for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
}

describe("node transfer protocol", () => {
  it("rejects absolute and traversal paths", () => {
    expect(() => assertWorkspacePath("../secret")).toThrowError(TransferError);
    expect(() => assertWorkspacePath("/etc/passwd")).toThrowError(TransferError);
    expect(() => assertWorkspacePath("C:\\secret")).toThrowError(TransferError);
    expect(assertWorkspacePath("projects/a.txt")).toBe("projects/a.txt");
  });

  it("creates an expiring manifest with a scoped R2 key", () => {
    const manifest = createTransferManifest(base);
    expect(manifest.objectKey).toBe(transferObjectKey(manifest));
    expect(manifest.expiresAt).toBe("2026-01-01T00:10:00.000Z");
  });

  it("signs tokens to one transfer and one direction", async () => {
    const manifest = createTransferManifest(base);
    const signer = hmacSigner("workspace-secret");
    const token = await issueTransferToken(manifest, "upload", signer);
    const protocol = createTransferProtocol({ store: { put: async () => {}, get: async () => null }, signer, now: () => base.now });
    expect(await protocol.authorize(manifest, token, "upload")).toBe(true);
    expect(await protocol.authorize(manifest, token, "download")).toBe(false);
    const expired = { ...manifest, expiresAt: "2025-12-31T23:59:59.000Z" };
    expect(await protocol.authorize(expired, token, "upload")).toBe(false);
  });

  it("bounds streamed uploads and rejects a short body", async () => {
    const bounded = await boundedStream(stream("a", "bc"), 3, 10);
    const response = new Response(bounded);
    expect(await response.text()).toBe("abc");
    const short = await boundedStream(stream("ab"), 3, 10);
    await expect(new Response(short).arrayBuffer()).rejects.toThrow("content length");
  });

  it("stores a streaming upload and never accepts an over-sized body", async () => {
    const stored: Uint8Array[] = [];
    const manifest = createTransferManifest(base);
    const signer = hmacSigner("workspace-secret");
    const token = await issueTransferToken(manifest, "upload", signer);
    const protocol = createTransferProtocol({ signer, store: { put: async (_key, body) => { const reader = body.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; stored.push(next.value); } }, get: async () => null }, now: () => base.now });
    await protocol.put(manifest, token, stream("a", "bc"));
    expect(new TextDecoder().decode(Uint8Array.from(stored.flatMap((part) => [...part])))).toBe("abc");
    await expect(protocol.put(manifest, token, stream("abcd"))).rejects.toThrow("exceeds transfer limit");
  });
});
