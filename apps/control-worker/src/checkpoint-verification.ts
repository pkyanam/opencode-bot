import { createHash } from "node:crypto";

type CheckpointObject = {
  size?: number;
  body?: ReadableStream<Uint8Array>;
};

/** Verify an R2 checkpoint without materializing the archive in Worker memory. */
export async function verifyCheckpointObject(object: CheckpointObject, expectedSize: number, expectedSha256: string): Promise<void> {
  if (!object || object.size !== expectedSize || !object.body) throw new Error("Checkpoint verification failed. The app has not been changed.");
  const hash = createHash("sha256");
  const reader = object.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expectedSize) throw new Error("Checkpoint verification failed. The app has not been changed.");
      hash.update(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (size !== expectedSize || hash.digest("hex") !== expectedSha256) throw new Error("Checkpoint verification failed. The app has not been changed.");
}
