import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalComputerProvider } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fakeProcess() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    exitCode: null,
    killed: false,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      for (const fn of listeners.get("exit") ?? []) fn();
    },
    once(event: string, fn: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return this;
    },
    on(event: string, fn: () => void) {
      return this.once(event, fn);
    },
  } as any;
}

describe("LocalComputerProvider", () => {
  it("deduplicates concurrent starts and fences stale transports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    let starts = 0;
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const provider = new LocalComputerProvider({
      dataDir: root,
      spawn: (_command, _args, options) => {
        starts++;
        spawnedEnv = options.env;
        return fakeProcess();
      },
      fetch: async (_url, init) =>
        new Response(JSON.stringify({ ok: true }), {
          status: init?.method === "POST" ? 200 : 200,
        }),
    });
    const [first, second] = await Promise.all([
      provider.ensure({ computerId: "one", runnerToken: "secret" }),
      provider.ensure({ computerId: "one", runnerToken: "secret" }),
    ]);
    expect(first.generation).toBe(1);
    expect(second.runnerPort).toBe(first.runnerPort);
    expect(starts).toBe(1);
    expect(spawnedEnv?.RUNNER_HOST).toBe("127.0.0.1");
    expect(spawnedEnv?.OPENCODE_BOT_EXTERNAL_DISPLAY).toBe("1");
    const transport = await provider.connect("one", {
      computerId: "one",
      generation: 1,
      token: "secret",
    });
    expect((await transport.fetch("/health")).status).toBe(200);
    await expect(
      provider.connect("one", {
        computerId: "one",
        generation: 2,
        token: "secret",
      }),
    ).rejects.toThrow(/generation/);
  });

  it("uses the provider workspace default when the spec omits one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    const workspace = path.join(root, "shared-workspace");
    const provider = new LocalComputerProvider({
      dataDir: root,
      workspacePath: workspace,
      spawn: () => fakeProcess(),
      fetch: async () => new Response(null, { status: 200 }),
    });
    const handle = await provider.ensure({
      computerId: "shared",
      runnerToken: "secret",
    });
    expect(handle.workspacePath).toBe(workspace);
  });

  it("archives to and restores from a streaming local object store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "value.txt"), "before", "utf8");
    let stored: Uint8Array | undefined;
    const store = {
      put: async (_key: string, body: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body as any)
          chunks.push(new Uint8Array(chunk));
        stored = Buffer.concat(chunks as any);
      },
      get: async () =>
        stored
          ? {
              size: stored.byteLength,
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(stored);
                  controller.close();
                },
              }),
            }
          : null,
    };
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const provider = new LocalComputerProvider({
      dataDir: root,
      checkpointStore: store,
      checkpointPaths: [workspace],
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      spawn: () => fakeProcess(),
    });
    const handle = await provider.ensure({
      computerId: "one",
      runnerToken: "secret",
      workspacePath: workspace,
    });
    const manifest = await provider.checkpoint("one", 1);
    expect(manifest.durable).toBe(true);
    expect(stored?.byteLength).toBeGreaterThan(0);
    expect(
      requests
        .filter((request) => request.url.includes("checkpoint"))
        .every((request) => request.authorization === "Bearer secret"),
    ).toBe(true);
    await writeFile(path.join(workspace, "value.txt"), "after", "utf8");
    await provider.restore("one", manifest);
    expect(await readFile(path.join(workspace, "value.txt"), "utf8")).toBe(
      "before",
    );
    const corrupted = new Uint8Array(stored!);
    corrupted[corrupted.length - 1] ^= 1;
    stored = corrupted;
    await writeFile(path.join(workspace, "value.txt"), "still-here", "utf8");
    await expect(provider.restore("one", manifest)).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(await readFile(path.join(workspace, "value.txt"), "utf8")).toBe(
      "still-here",
    );
    await provider.stop(handle.id, "force");
    await provider.stop(handle.id, "force");
  });

  it("always resumes after checkpoint path validation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    const calls: string[] = [];
    const provider = new LocalComputerProvider({
      dataDir: root,
      checkpointStore: { put: async () => undefined, get: async () => null },
      checkpointPaths: ["relative/path"],
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      },
      spawn: () => fakeProcess(),
    });
    await provider.ensure({ computerId: "validation", runnerToken: "secret" });
    await expect(provider.checkpoint("validation", 1)).rejects.toThrow(
      /Unsafe checkpoint path/,
    );
    expect(calls.some((url) => url.endsWith("/checkpoint/quiesce"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/checkpoint/resume"))).toBe(true);
  });

  it("surfaces synchronous runner spawn failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    const provider = new LocalComputerProvider({
      dataDir: root,
      spawn: () => {
        throw new Error("spawn denied");
      },
      fetch: async () => new Response(null, { status: 200 }),
    });
    await expect(
      provider.ensure({ computerId: "spawn-failure", runnerToken: "secret" }),
    ).rejects.toThrow(/Could not spawn runner.*spawn denied/);
  });

  it("keeps existing roots when staged extraction fails before swap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "local-computer-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "value.txt"), "original", "utf8");
    let stored: Uint8Array | undefined;
    const store = {
      put: async (_key: string, body: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body as any)
          chunks.push(new Uint8Array(chunk));
        stored = Buffer.concat(chunks as any);
      },
      get: async () =>
        stored
          ? {
              size: stored.byteLength,
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(stored);
                  controller.close();
                },
              }),
            }
          : null,
    };
    const provider = new LocalComputerProvider({
      dataDir: root,
      checkpointStore: store,
      checkpointPaths: [workspace],
      fetch: async () => new Response(null, { status: 200 }),
      spawn: () => fakeProcess(),
    });
    await provider.ensure({
      computerId: "staged",
      runnerToken: "secret",
      workspacePath: workspace,
    });
    const manifest = await provider.checkpoint("staged", 1);
    await writeFile(path.join(workspace, "value.txt"), "changed", "utf8");
    const badManifest = {
      ...manifest,
      paths: [workspace, path.join(root, "missing-root")],
    };
    await expect(provider.restore("staged", badManifest)).rejects.toThrow();
    expect(await readFile(path.join(workspace, "value.txt"), "utf8")).toBe(
      "changed",
    );
  });
});
