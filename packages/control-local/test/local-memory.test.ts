import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalControl } from "../src/index";

describe("local Hindsight wiring", () => {
  it("installs the supervisor adapter when only its token is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-local-memory-"));
    let factory: ((instance: (id: string) => void) => { fetch(path: string, init?: RequestInit): Promise<Response> }) | undefined;
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname === "/health") return new Response(JSON.stringify({ upstreamReady: true, instanceId: "test-instance" }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const control = await createLocalControl({
      databasePath: join(root, "state.sqlite"),
      appToken: "test-token",
      hindsightToken: "supervisor-token",
      workspaceFactory: (_state, env) => {
        factory = env.HINDSIGHT_FACTORY as typeof factory;
        return { fetch: async () => new Response("ok") };
      },
      worker: { fetch: async () => new Response("ok") },
    });
    try {
      expect(factory).toEqual(expect.any(Function));
      const adapter = factory!(() => undefined);
      await expect(adapter.fetch("/v1/default/banks/b/memories/recall")).resolves.toMatchObject({ ok: true });
      expect(calls.map((call) => call.path)).toEqual(["/health", "/v1/default/banks/b/memories/recall"]);
      expect(calls.every((call) => call.authorization === "Bearer supervisor-token")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await control.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
