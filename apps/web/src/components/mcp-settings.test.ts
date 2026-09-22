import { afterEach, describe, expect, it, vi } from "vitest";
import { callbackValue, readAttempts, writeAttempts } from "./mcp-settings";

describe("MCP OAuth attempt helpers", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("restores pending services across reloads and removes expired attempts", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", { location: { origin: "https://test.example" } });
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => data.get(key), setItem: (key: string, value: string) => data.set(key, value) });
    const attempt = { server: "one", integrationID: "one", methodID: "oauth", attemptID: "a", expiresAt: Date.now() + 60000 };
    writeAttempts([attempt, { ...attempt, server: "expired", attemptID: "b", expiresAt: 1 }]);
    expect(readAttempts()).toEqual([attempt]);
    vi.stubGlobal("window", { location: { origin: "https://another.example" } });
    expect(readAttempts()).toEqual([]);
  });
  it("keeps callback URLs intact for native state validation", () => {
    const value = "https://localhost/callback?code=one-time&state=opaque";
    expect(callbackValue(value)).toEqual({ callbackUrl: value });
  });
  it("accepts a plain one-time code without treating it as an API token", () => {
    expect(callbackValue("one-time-code")).toEqual({ code: "one-time-code" });
  });
  it("rejects callback URLs without an authorization code", () => {
    expect(() => callbackValue("https://localhost/callback?error=denied")).toThrow("denied");
  });
  it("does not fail when session storage is unavailable", () => {
    expect(readAttempts()).toEqual([]);
  });
});
