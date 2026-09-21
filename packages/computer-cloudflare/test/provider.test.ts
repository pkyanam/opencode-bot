import assert from "node:assert/strict";
import { it } from "vitest";
import { CloudflareComputerProvider, type CloudflareSandboxBinding } from "../src/index.js";

function fakeSandbox(options: { archive?: Uint8Array; archiveStatBytes?: number; calls?: string[]; execs?: string[]; reads?: { value: number }; streamReads?: { value: number }; streamArchive?: boolean; sdkStream?: boolean; resumeFailure?: boolean } = {}) {
  let starts = 0;
  const calls = options.calls ?? [];
  const process = {
    status: 'running',
    kill: async () => undefined,
    waitForPort: async () => undefined,
  };
  return {
    get starts() {
      return starts;
    },
    containerFetch: async (_url: string, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${_url}`);
      if (options.resumeFailure && _url.endsWith("/checkpoint/resume")) return new Response(null, { status: 503 });
      if (init.method === "GET") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    },
    startProcess: async () => {
      starts += 1;
      return process;
    },
    getProcess: async () => starts ? process : null,
    stop: async () => undefined,
    destroy: async () => undefined,
    exec: async (command: string) => { options.execs?.push(command); return { success: true, exitCode: 0, stdout: command.startsWith("stat") ? String(options.archiveStatBytes ?? options.archive?.byteLength ?? 0) : command.startsWith("sha256sum") ? `${"a".repeat(64)}  archive\n` : command.startsWith("tar -tzf") ? "workspace/state/\nworkspace/shared/\nworkspace/browser/\n" : "", stderr: "", command, duration: 0, timestamp: new Date().toISOString() }; },
    ...(options.sdkStream ? { readFileStream: async () => {
      const archive = options.archive ?? new Uint8Array();
      const encoded = Buffer.from(archive).toString("base64");
      const wire = [
        `data: ${JSON.stringify({ type: "metadata", mimeType: "application/gzip", size: archive.byteLength, isBinary: true, encoding: "base64" })}\n\n`,
        `data: ${JSON.stringify({ type: "chunk", data: encoded })}\n\n`,
        `data: ${JSON.stringify({ type: "complete" })}\n\n`,
      ].join("");
      return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(wire)); controller.close(); } });
    } } : {}),
    readFile: async (_path: string, readOptions?: { encoding?: string }) => {
      if (options.sdkStream && readOptions?.encoding === "none") throw new Error("encoding none requires rpc transport");
      if (readOptions?.encoding === "none" && options.streamArchive) {
        if (options.streamReads) options.streamReads.value += 1;
        const archive = options.archive;
        return {
          success: true,
          path: "",
          content: new ReadableStream<Uint8Array>({
            start(controller) {
              if (archive) {
                for (let offset = 0; offset < archive.byteLength; offset += 64 * 1024) {
                  controller.enqueue(archive.subarray(offset, Math.min(offset + 64 * 1024, archive.byteLength)));
                }
              }
              controller.close();
            },
          }),
          size: archive?.byteLength ?? 0,
          mimeType: "application/gzip",
          timestamp: "",
        };
      }
      if (options.reads) options.reads.value += 1;
      return { success: Boolean(options.archive), path: "", content: options.archive ? Buffer.from(options.archive).toString("base64") : "", timestamp: "" };
    },
    writeFile: async () => ({ success: true, path: "", timestamp: "" }),
  };
}

it("ensures a runner once and scopes transport with bearer and generation", async () => {
  const sandbox = fakeSandbox();
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: () => sandbox as never,
  });
  const handle = await provider.ensure({ computerId: "c1", runnerToken: "secret" });
  assert.equal(handle.status.runner, "ready");
  assert.equal(sandbox.starts, 1);
  const transport = await provider.connect("c1", { computerId: "c1", generation: 1, token: "secret" });
  const response = await transport.fetch("/runs", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(await provider.inspect("c1").then((status) => status.generation), 1);
});

it("passes keepAlive to the Sandbox factory by default and honors an explicit idle policy", async () => {
  const seen: Array<{ keepAlive: boolean; sleepAfter?: string | number }> = [];
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: (_namespace, _key, options) => { seen.push(options!); return fakeSandbox() as never; },
  });
  await provider.ensure({ computerId: "live", runnerToken: "secret" });
  const idleProvider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    keepAlive: false,
    sleepAfter: "30m",
    sandboxFactory: (_namespace, _key, options) => { seen.push(options!); return fakeSandbox() as never; },
  });
  await idleProvider.ensure({ computerId: "idle", runnerToken: "secret" });
  assert.deepEqual(seen, [{ keepAlive: true, sleepAfter: undefined }, { keepAlive: false, sleepAfter: "30m" }]);
});

it("reports ephemeral disk as unsupported without R2 and rejects stale leases", async () => {
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: () => fakeSandbox() as never,
  });
  await provider.ensure({ computerId: "c2", runnerToken: "secret" });
  const manifest = await provider.checkpoint("c2", 1);
  assert.equal(manifest.durable, false);
  await assert.rejects(() => provider.connect("c2", { computerId: "c2", generation: 2, token: "secret" }), /generation/);
});

it("quiesces, uploads, and restores an R2 checkpoint, including resume on size rejection", async () => {
  const calls: string[] = [];
  const archive = new TextEncoder().encode("fake tar archive");
  const sandbox = fakeSandbox({ archive, calls });
  let stored: Uint8Array | undefined;
  const bucket = {
    put: async (_key: string, value: ArrayBuffer | ArrayBufferView) => { stored = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)); },
    get: async () => stored ? { size: stored.byteLength, arrayBuffer: async () => stored!.buffer } : null,
  };
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: () => sandbox as never,
    checkpointBucket: bucket as never,
    maxCheckpointBytes: 1024,
  });
  await provider.ensure({ computerId: "c3", runnerToken: "secret" });
  const manifest = await provider.checkpoint("c3", 1);
  assert.equal(manifest.durable, true);
  assert.ok(stored);
  await provider.restore("c3", manifest);
  assert.deepEqual(calls.filter((call) => call.includes("checkpoint")), [
    "POST http://127.0.0.1/checkpoint/quiesce",
    "POST http://127.0.0.1/checkpoint/resume",
    "POST http://127.0.0.1/checkpoint/quiesce",
    "POST http://127.0.0.1/checkpoint/resume",
  ]);

  const oversized = fakeSandbox({ archive: new Uint8Array(2_000), calls: [] });
  const second = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => oversized as never, checkpointBucket: bucket as never, maxCheckpointBytes: 10 });
  await second.ensure({ computerId: "c4", runnerToken: "secret" });
  await assert.rejects(() => second.checkpoint("c4", 1), /maximum/);
});

it("checks the archive size before buffering and surfaces a failed resume", async () => {
  const reads = { value: 0 };
  const oversized = fakeSandbox({ archive: new Uint8Array(2_000), reads });
  const bucket = { put: async () => undefined, get: async () => null };
  const provider = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => oversized as never, checkpointBucket: bucket as never, maxCheckpointBytes: 10 });
  await provider.ensure({ computerId: "c5", runnerToken: "secret" });
  await assert.rejects(() => provider.checkpoint("c5", 1), /maximum/);
  assert.equal(reads.value, 0);

  const resumeless = fakeSandbox({ archive: new TextEncoder().encode("small"), resumeFailure: true });
  const second = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => resumeless as never, checkpointBucket: bucket as never });
  await second.ensure({ computerId: "c6", runnerToken: "secret" });
  await assert.rejects(() => second.checkpoint("c6", 1), /failed to resume/);
});

it("uses bounded raw binary streaming for a default-sized checkpoint", async () => {
  const archive = new Uint8Array(17 * 1024 * 1024);
  const streamReads = { value: 0 };
  const execs: string[] = [];
  let stored: Uint8Array | undefined;
  const sandbox = fakeSandbox({ archive, streamArchive: true, streamReads, execs });
  const bucket = {
    put: async (_key: string, value: ArrayBuffer | ArrayBufferView) => {
      stored = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    },
    get: async () => null,
  };
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: () => sandbox as never,
    checkpointBucket: bucket as never,
  });
  await provider.ensure({ computerId: "streamed", runnerToken: "secret" });
  const manifest = await provider.checkpoint("streamed", 1);
  assert.equal(streamReads.value, 1);
  assert.equal(manifest.bytes, archive.byteLength);
  assert.equal(stored?.byteLength, archive.byteLength);
  const tarCommand = execs.find((command) => command.startsWith("tar -czf"));
  assert.ok(tarCommand);
  assert.match(tarCommand, /--exclude='workspace\/browser\/profile\/Default\/Cache'/);
  assert.match(tarCommand, /--exclude='workspace\/browser\/profile\/BrowserMetrics-spare\.pma'/);
  assert.doesNotMatch(tarCommand, /--exclude='workspace\/browser\/profile'/);
});

it("stops consuming a raw stream at the configured checkpoint bound", async () => {
  const streamReads = { value: 0 };
  const oversized = fakeSandbox({ archive: new Uint8Array(2_000), archiveStatBytes: 0, streamArchive: true, streamReads });
  let uploads = 0;
  const bucket = { put: async () => { uploads += 1; }, get: async () => null };
  const provider = new CloudflareComputerProvider({
    sandboxNamespace: {} as CloudflareSandboxBinding,
    sandboxFactory: () => oversized as never,
    checkpointBucket: bucket as never,
    maxCheckpointBytes: 10,
  });
  await provider.ensure({ computerId: "streamed-oversized", runnerToken: "secret" });
  await assert.rejects(() => provider.checkpoint("streamed-oversized", 1), /maximum/);
  assert.equal(streamReads.value, 1);
  assert.equal(uploads, 0);
});

it("uploads large checkpoints with bounded multipart parts and aborts failed uploads", async () => {
  const archive = new Uint8Array(6 * 1024 * 1024 + 17);
  const sandbox = fakeSandbox({ archive, streamArchive: true, sdkStream: true });
  const uploaded: Uint8Array[] = [];
  let aborted = false;
  const bucket = {
    createMultipartUpload: async () => ({
      uploadPart: async (_part: number, value: ArrayBuffer | ArrayBufferView) => {
        uploaded.push(new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
        return { etag: `etag-${uploaded.length}` };
      },
      complete: async () => undefined,
      abort: async () => { aborted = true; },
    }),
    put: async () => undefined,
    get: async () => null,
  };
  const provider = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => sandbox as never, checkpointBucket: bucket as never });
  await provider.ensure({ computerId: "multipart", runnerToken: "secret" });
  const manifest = await provider.checkpoint("multipart", 1);
  assert.equal(manifest.bytes, archive.byteLength);
  assert.deepEqual(uploaded.map((part) => part.byteLength), [5 * 1024 * 1024, 1 * 1024 * 1024 + 17]);
  assert.equal(aborted, false);

  const failing = {
    ...bucket,
    createMultipartUpload: async () => ({
      uploadPart: async () => { throw new Error("R2 unavailable"); },
      complete: async () => undefined,
      abort: async () => { aborted = true; },
    }),
  };
  const second = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => fakeSandbox({ archive, streamArchive: true, sdkStream: true }) as never, checkpointBucket: failing as never });
  await second.ensure({ computerId: "multipart-fail", runnerToken: "secret" });
  await assert.rejects(() => second.checkpoint("multipart-fail", 1), /R2 unavailable/);
  assert.equal(aborted, true);
});

it("verifies ranged restore checksum before deleting checkpoint roots", async () => {
  const archive = new TextEncoder().encode("checkpoint");
  const writes: string[] = [];
  const sandbox = fakeSandbox({ archive });
  const originalWrite = sandbox.writeFile as (...args: any[]) => Promise<any>;
  (sandbox as any).writeFile = async (path: string, content: string, options?: { encoding?: string }) => {
    writes.push(path);
    return originalWrite(path, content, options);
  };
  const bucket = {
    put: async () => undefined,
    head: async () => ({ size: archive.byteLength }),
    get: async (_key: string, options?: { range?: { offset?: number; length?: number } }) => {
      if (!options?.range) return { size: archive.byteLength, arrayBuffer: async () => archive.buffer };
      const offset = options.range.offset ?? 0;
      const length = options.range.length ?? archive.byteLength;
      return { size: length, arrayBuffer: async () => archive.slice(offset, offset + length).buffer };
    },
  };
  const provider = new CloudflareComputerProvider({ sandboxNamespace: {} as CloudflareSandboxBinding, sandboxFactory: () => sandbox as never, checkpointBucket: bucket as never });
  await provider.ensure({ computerId: "restore-checksum", runnerToken: "secret" });
  await assert.rejects(() => provider.restore("restore-checksum", { id: "bad", computerId: "restore-checksum", createdAt: "", supported: true, durable: true, checkpointKey: "key", sha256: "b".repeat(64), bytes: archive.byteLength, paths: ["/workspace/state"] }), /checksum mismatch/);
  assert.ok(writes.some((path) => path.includes("restore-checksum")));
  assert.doesNotMatch(writes.join("\n"), /workspace\/state/);
});
