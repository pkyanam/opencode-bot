import { describe, expect, it, vi } from "vitest";
import { LocalHindsight } from "./hindsight-local";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("LocalHindsight", () => {
  it("configures the supervisor from explicit provider settings and forwards auth", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    let configured = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname; calls.push({ path, init });
      if (path === "/health") return json({ configured, upstreamReady: configured, instanceId: "epoch-1" }, configured ? 200 : 503);
      if (path === "/configure") { configured = true; return json({ configured: true, running: true, instanceId: "epoch-1" }); }
      return json({ results: [] });
    }) as unknown as typeof fetch;
    const instance = vi.fn();
    const adapter = new LocalHindsight({ token: "runner-secret", llmBaseUrl: "https://llm.example/v1", llmApiKey: "model-secret", llmModel: "model", fetcher, instance });
    const response = await adapter.fetch("/v1/default/banks/b/memories/recall", { method: "POST", body: "{}" });
    expect(response.ok).toBe(true);
    expect(calls.map(call => call.path)).toEqual(["/configure", "/health", "/v1/default/banks/b/memories/recall"]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer runner-secret");
    expect(instance).toHaveBeenCalledWith("epoch-1");
  });

  it("fails closed without a complete provider configuration", async () => {
    const fetcher = vi.fn(async () => json({ configured: false, upstreamReady: false }, 503)) as unknown as typeof fetch;
    const adapter = new LocalHindsight({ token: "runner", fetcher });
    await expect(adapter.fetch("/v1/default/banks/b/stats")).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects partial or unsafe provider settings before making requests", () => {
    expect(() => new LocalHindsight({ token: "runner", llmApiKey: "key" })).toThrow(/together/);
    expect(() => new LocalHindsight({ token: "runner", llmBaseUrl: "file:///secret", llmApiKey: "key", llmModel: "m" })).toThrow(/http/);
  });

  it("does not expose credentials in local health failures", async () => {
    const fetcher = vi.fn(async () => new Response("invalid", { status: 502 })) as unknown as typeof fetch;
    const adapter = new LocalHindsight({ token: "runner-secret", fetcher });
    await expect(adapter.health()).rejects.toThrow(/not ready|unavailable/);
    await expect(adapter.health()).rejects.not.toThrow(/runner-secret/);
  });
});
