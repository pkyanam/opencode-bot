import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = vi.hoisted(() => ({
  getItemAsync: vi.fn(async () => null as string | null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
// The root test runtime does not install Expo modules; Vitest still accepts
// this virtual connector mock when running the pure API contract tests.
// @ts-expect-error Vitest's runtime supports the virtual mock option.
vi.mock("expo-secure-store", () => secure, { virtual: true });

import { api, ApiError, normalizeMessages, setCachedToken } from "./api";

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("mobile API contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCachedToken("dt_test");
  });

  it("sends CRUD payloads and URL-encodes identifiers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "bot_1", name: "Scout" }))
      .mockResolvedValueOnce(jsonResponse({ id: "thread_1", title: "Plan" }))
      .mockResolvedValueOnce(jsonResponse({ id: "thread_1", title: "Renamed" }))
      .mockResolvedValueOnce(jsonResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = api("https://workspace.example");
    await client.createBot({ name: "Scout", instructions: "Inspect", model: "openai/gpt" });
    await client.createThread("bot/1", "Plan");
    await client.renameThread("thread/1", "Renamed");
    await client.deleteBot("bot/1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://workspace.example/api/bots",
      "https://workspace.example/api/threads",
      "https://workspace.example/api/threads/thread%2F1",
      "https://workspace.example/api/bots/bot%2F1",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ name: "Scout", model: "openai/gpt" });
    expect(fetchMock.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer dt_test");
  });

  it("returns empty catalogs and reads text file content without JSON parsing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ artifacts: [] }))
      .mockResolvedValueOnce(new Response("hello\nworld", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = api("https://workspace.example");
    expect(await client.skills()).toEqual([]);
    expect(await client.files("src")).toEqual({ artifacts: [] });
    expect(await client.fileContent("src/readme.md")).toBe("hello\nworld");
    expect(fetchMock.mock.calls[2][0]).toBe("https://workspace.example/api/files/content?path=src%2Freadme.md");
    expect(fetchMock.mock.calls[2][1].headers.get("Accept")).toContain("text/plain");
  });

  it("surfaces structured API errors and rejects unsafe remote HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden", code: "denied" }, 403)));
    await expect(api("https://workspace.example").state()).rejects.toMatchObject({
      status: 403,
      code: "denied",
      message: "forbidden",
    } satisfies Partial<ApiError>);
    await expect(api("http://public.example").state()).rejects.toThrow("HTTPS");
  });

  it("does not attach an existing token to pairing redemption", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deviceToken: "dt_new" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await api("https://workspace.example").redeem("ps_invite", "Phone");
    expect(fetchMock.mock.calls[0][1].headers.get("Authorization")).toBeNull();
  });

  it("orders native messages chronologically and drops empty assistant bubbles", () => {
    const messages = normalizeMessages([
      { id: "assistant", type: "assistant", time: { created: 2000 }, content: [{ type: "text", text: "done" }] },
      { id: "empty", type: "assistant", time: { created: 1500 }, content: [] },
      { id: "user", type: "user", time: { created: 1000 }, text: "start" },
      { id: "tool", type: "assistant", time: { created: 1800 }, content: [{ type: "tool", callID: "call-1", name: "read", state: { status: "completed", content: [{ type: "text", text: "ok" }] } }] },
    ]);
    expect(messages.map((message) => message.id)).toEqual(["user", "tool", "assistant"]);
    expect(messages[1].parts?.[0]).toMatchObject({ type: "tool", id: "call-1", output: "ok" });
  });
});
