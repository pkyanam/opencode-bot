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
vi.mock("expo-file-system", () => ({
  File: class MockExpoFile extends Blob {
    uri: string;
    constructor(uri: string) {
      super([], { type: "application/octet-stream" });
      this.uri = uri;
    }
    bytes() {
      return this.arrayBuffer().then((value) => new Uint8Array(value));
    }
  },
}), { virtual: true });

import { api, ApiError, normalizeMessages, setCachedToken } from "./api";

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("mobile API contract", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
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

  it("builds memory list and revision-aware mutation requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "memory/1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "memory/1" }))
      .mockResolvedValueOnce(jsonResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = api("https://workspace.example");
    await client.memories({ botId: "bot/1", q: "favorite", limit: 100, offset: 100 });
    await client.createMemory({ botId: "bot/1", content: "Use dark mode", visibility: "shared", sharedBotIds: ["bot/2"] });
    await client.updateMemory("memory/1", { revision: 2, content: "Use warm dark mode" });
    await client.deleteMemory("memory/1", 3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://workspace.example/api/memory?botId=bot%2F1&q=favorite&limit=100&offset=100",
      "https://workspace.example/api/memory",
      "https://workspace.example/api/memory/memory%2F1",
      "https://workspace.example/api/memory/memory%2F1?revision=3",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ revision: 2, content: "Use warm dark mode" });
  });

  it("supports the Hindsight engine lifecycle and scoped operations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ provider: "hindsight", configured: false, enabled: false, status: "disabled", pending: false, failed: false, settings: { autoCapture: false }, capabilities: [] }))
      .mockResolvedValueOnce(jsonResponse({ provider: "hindsight", configured: true, enabled: true, status: "starting", pending: true, failed: false, settings: { url: "https://hindsight", autoCapture: true }, capabilities: ["recall", "reflect"] }))
      .mockResolvedValueOnce(jsonResponse({ provider: "hindsight", configured: true, enabled: true, status: "ready", pending: false, failed: false, settings: { url: "https://hindsight", autoCapture: true }, capabilities: ["retain", "recall", "reflect"] }))
      .mockResolvedValueOnce(jsonResponse({ provider: "hindsight", text: "A useful memory." }))
      .mockResolvedValueOnce(jsonResponse({ provider: "hindsight", text: "A considered reflection." }));
    vi.stubGlobal("fetch", fetchMock);
    const client = api("https://workspace.example");
    await client.hindsightEngine();
    await client.configureHindsight({ url: "https://hindsight", apiKey: "secret", enabled: true, autoCapture: true });
    await client.syncHindsight();
    await client.hindsightRecall({ botId: "bot/1", query: "favorite color", budget: "low" });
    await client.hindsightReflect({ botId: "bot/1", query: "what changed", budget: "high" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://workspace.example/api/memory/engine",
      "https://workspace.example/api/memory/engine",
      "https://workspace.example/api/memory/engine/sync",
      "https://workspace.example/api/memory/recall",
      "https://workspace.example/api/memory/reflect",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ url: "https://hindsight", apiKey: "secret", enabled: true, autoCapture: true });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ botId: "bot/1", query: "favorite color", budget: "low" });
  });

  it("normalizes Hindsight observations and mental model collections", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "obs_1", text: "Likes tea" }] }))
      .mockResolvedValueOnce(jsonResponse({ mental_models: [{ id: "model_1", name: "Preferences", content: "Tea" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "model_2", name: "Plans" }))
      .mockResolvedValueOnce(jsonResponse({ id: "model_1", name: "Preferences", content: "Coffee" }))
      .mockResolvedValueOnce(jsonResponse(undefined, 204));
    vi.stubGlobal("fetch", fetchMock);
    const client = api("https://workspace.example");
    expect(await client.hindsightObservations("bot/1")).toEqual([{ id: "obs_1", text: "Likes tea" }]);
    expect(await client.hindsightMentalModels("bot/1")).toEqual([{ id: "model_1", name: "Preferences", content: "Tea" }]);
    await client.createHindsightMentalModel({ botId: "bot/1", name: "Plans", query: "What are the plans?" });
    await client.refreshHindsightMentalModel("model/1", "bot/1");
    await client.deleteHindsightMentalModel("model/1", "bot/1");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://workspace.example/api/memory/observations?botId=bot%2F1",
      "https://workspace.example/api/memory/mental-models?botId=bot%2F1",
      "https://workspace.example/api/memory/mental-models",
      "https://workspace.example/api/memory/mental-models/model%2F1/refresh",
      "https://workspace.example/api/memory/mental-models/model%2F1?botId=bot%2F1",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ botId: "bot/1", name: "Plans", query: "What are the plans?" });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ botId: "bot/1" });
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

  it("passes native file bytes to Expo without creating an ArrayBuffer-backed RN Blob", async () => {
    class NativeForm {
      parts: Array<[string, any]> = [];
      append(name: string, part: unknown) { this.parts.push([name, part]); }
      getParts() { return this.parts; }
    }
    vi.stubGlobal("FormData", NativeForm);
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ attachment: { id: "native" } }));
    vi.stubGlobal("fetch", fetcher);
    await api("https://workspace.example").upload({ uri: "file:///photo.heic", name: "My photo.heic", mimeType: "image/heic" });
    const part = (fetcher.mock.calls[0][1].body as NativeForm).parts[0][1];
    expect(part.name).toBe("My photo.heic");
    expect(part.type).toBe("image/heic");
    expect(typeof part.bytes).toBe("function");
    expect(await part.bytes()).toBeInstanceOf(Uint8Array);
    expect(fetcher.mock.calls[0][1].headers.has("Content-Type")).toBe(false);
  });

  it("uploads a native Blob part with the picked filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ attachment: { id: "att_1", name: "photo.jpg", mimeType: "image/jpeg", size: 12 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api("https://workspace.example").upload({
      uri: "file:///cache/photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    const part = body.get("file");
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe("photo.jpg");
    expect((part as Blob).type).toBe("image/jpeg");
    expect(fetchMock.mock.calls[0][1].headers.get("Content-Type")).toBeNull();
  });

  it("uses an octet-stream MIME type when the picker omits one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ attachment: { id: "att_2", name: "payload.bin", mimeType: "application/octet-stream", size: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api("https://workspace.example").upload({
      uri: "file:///cache/payload.bin",
      name: "payload.bin",
    });
    const part = (fetchMock.mock.calls[0][1].body as FormData).get("file") as Blob;
    expect(part).toBeInstanceOf(Blob);
    expect(part.type).toBe("application/octet-stream");
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

  it("sanitizes structured and oversized tool output before rendering", () => {
    const huge = "A".repeat(20_000);
    const messages = normalizeMessages([
      {
        id: "structured",
        type: "assistant",
        content: [
          null,
          { type: "tool", callID: "call-structured", name: "picture", state: {
            status: "completed",
            content: { files: [{ name: "photo.png", data: `data:image/png;base64,${huge}` }], ok: true },
          } },
          { type: "text", text: huge },
        ],
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content.length).toBeLessThanOrEqual(16_001);
    const tool = messages[0].parts?.find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", output: expect.stringContaining("[binary data omitted]") });
    expect(typeof tool?.output).toBe("string");
  });
});

 it('renders the structured HEIC read failure from Pictures as a failed tool rather than an object', () => {
  const [message] = normalizeMessages([{id:'picture',type:'assistant',content:[{type:'tool',name:'read',state:{status:'error',error:{type:'unknown',message:'Cannot read binary file: photo.heic'}}}]}]);
  expect(message.parts?.[0]).toMatchObject({type:'tool',status:'failed',error:'Cannot read binary file: photo.heic'});
 });
