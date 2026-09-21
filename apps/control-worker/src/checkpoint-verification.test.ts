import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCheckpointObject } from "./checkpoint-verification";

function objectFromChunks(chunks: Uint8Array[], size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)) {
  return { size, body: new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  }) };
}

describe("checkpoint verification", () => {
  it("hashes streamed chunks without requiring one archive-sized buffer", async () => {
    const chunks = [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
    const expected = createHash("sha256").update(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).digest("hex");
    await expect(verifyCheckpointObject(objectFromChunks(chunks), 11, expected)).resolves.toBeUndefined();
  });

  it("rejects size and digest mismatches", async () => {
    const chunks = [new TextEncoder().encode("archive")];
    const object = objectFromChunks(chunks);
    await expect(verifyCheckpointObject(object, 99, "0".repeat(64))).rejects.toThrow(/Checkpoint verification failed/);
    await expect(verifyCheckpointObject(objectFromChunks(chunks), chunks[0].byteLength, "0".repeat(64))).rejects.toThrow(/Checkpoint verification failed/);
  });
});
