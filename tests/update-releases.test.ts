import { describe, expect, it } from "vitest";
import { fetchUpdateBundle, fetchUpdateRelease } from "../apps/control-worker/src/update-releases";

const manifest = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  version: "v1.2.3",
  commit: "a".repeat(40),
  image: { reference: `docker.io/preethamk/opencode-bot@sha256:${"b".repeat(64)}` },
  ...extra,
});

const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

describe("update release downloads", () => {
  it("rejects a manifest whose requested version does not match its payload", async () => {
    const fetcher = async () => response(manifest({ version: "v1.2.4" })) as Response;
    await expect(fetchUpdateRelease("v1.2.3", fetcher as typeof fetch)).rejects.toThrow("manifest is invalid");
  });

  it("rejects a release with an untrusted image reference", async () => {
    const fetcher = async () => response(manifest({ image: { reference: "docker.io/other/app@sha256:" + "b".repeat(64) } })) as Response;
    await expect(fetchUpdateRelease(undefined, fetcher as typeof fetch)).rejects.toThrow("image is not trusted");
  });

  it("rejects an updater bundle larger than the declared maximum", async () => {
    const fetcher = async () => response(manifest({ updater: { file: "app-bundle.json", sha256: "c".repeat(64), size: 32 * 1024 * 1024 + 1 } })) as Response;
    await expect(fetchUpdateRelease(undefined, fetcher as typeof fetch)).rejects.toThrow("bundle metadata is invalid");
  });

  it("rejects a bundle when its downloaded bytes do not match the release digest", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).endsWith("release-manifest.json")) return response(manifest({ updater: { file: "app-bundle.json", sha256: "c".repeat(64), size: 3 } })) as Response;
      return response("bad");
    };
    await expect(fetchUpdateBundle("v1.2.3", fetcher as typeof fetch)).rejects.toThrow("verification failed");
  });

  it("rejects a response that exceeds the limit while streaming", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); controller.close(); },
    });
    const fetcher = async () => new Response(stream, { status: 200 }) as Response;
    await expect(fetchUpdateRelease(undefined, fetcher as typeof fetch)).rejects.toThrow("size limit");
  });
});
