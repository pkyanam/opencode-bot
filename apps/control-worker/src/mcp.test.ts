import { describe, expect, it, vi } from "vitest";
import {
  createMcpHandler,
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "./mcp";

const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://example.test/api/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify(body),
});
const read = async (response: Response) => ({ status: response.status, body: await response.json() as any });

describe("control MCP handler", () => {
  it("requires the injected bearer authorization check", async () => {
    const handler = createMcpHandler({ authorize: vi.fn().mockResolvedValue(false), invoke: vi.fn() });
    const result = await read(await handler(request({ jsonrpc: "2.0", id: 1, method: "ping" })));
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("unauthorized");
  });

  it("negotiates the initialize era and handles initialized notifications without SSE", async () => {
    const handler = createMcpHandler({ authorize: async () => true, invoke: vi.fn() });
    const initialized = await handler(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(initialized.status).toBe(202);
    const result = await read(await handler(request({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })));
    expect(result.status).toBe(200);
    expect(result.body.result.protocolVersion).toBe(MCP_LEGACY_VERSION);
    expect(result.body.result.capabilities.tools.listChanged).toBe(false);
  });

  it("supports modern per-request metadata and deterministic tools/list", async () => {
    const handler = createMcpHandler({ authorize: async () => true, invoke: vi.fn() });
    const body = {
      jsonrpc: "2.0", id: 2, method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
    };
    const result = await read(await handler(request(body, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/list" })));
    expect(result.status).toBe(200);
    const names = result.body.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("run_approve");
    expect(names).toContain("provider_configure");
  });

  it("allows the route owner to hide owner-only tools by paired-client scope", async () => {
    const handler = createMcpHandler({
      authorize: async () => true,
      invoke: vi.fn(),
      filterTools: (_request, tools) => tools.filter((tool) => !tool.name.startsWith("node_") && tool.name !== "checkpoint_restore"),
    });
    const body = { jsonrpc: "2.0", id: 20, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    const result = await read(await handler(request(body, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/list" })));
    const names = result.body.result.tools.map((tool: any) => tool.name);
    expect(names).not.toContain("node_list");
    expect(names).not.toContain("checkpoint_restore");
    expect(names).toContain("run_list");
  });

  it("validates modern mirrored headers and reports unsupported versions", async () => {
    const handler = createMcpHandler({ authorize: async () => true, invoke: vi.fn() });
    const mismatch = await read(await handler(request({ jsonrpc: "2.0", id: 3, method: "ping", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION } } }, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/list" })));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const unsupported = await read(await handler(request({ jsonrpc: "2.0", id: 4, method: "ping" }, { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "ping" })));
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe(-32022);
    expect(unsupported.body.error.data).toEqual({ supported: MCP_SUPPORTED_PROTOCOL_VERSIONS, requested: "2099-01-01" });
  });

  it("validates Origin and accepts the base64 sentinel form of Mcp-Name", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    const handler = createMcpHandler({ authorize: async () => true, invoke, allowOrigin: (origin) => origin === "https://trusted.example" });
    const body = { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "run_list", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    const name = "=?base64?" + btoa("run_list") + "?=";
    const rejected = await read(await handler(request(body, { origin: "https://evil.example", "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": name })));
    expect(rejected.status).toBe(403);
    const accepted = await read(await handler(request(body, { origin: "https://trusted.example", "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": name })));
    expect(accepted.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith({ path: "/api/runs", method: "GET" });
  });

  it("rejects modern requests missing metadata and mutating notifications", async () => {
    const handler = createMcpHandler({ authorize: async () => true, invoke: vi.fn() });
    const missingMeta = await read(await handler(request({ jsonrpc: "2.0", id: 31, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION } } }, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/list" })));
    expect(missingMeta.status).toBe(400);
    expect(missingMeta.body.error.code).toBe(-32000);
    const notification = await read(await handler(request({ jsonrpc: "2.0", method: "tools/call", params: { name: "run_cancel", arguments: { id: "run_1" }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "run_cancel" })));
    expect(notification.status).toBe(400);
    expect(notification.body.error.code).toBe(-32600);
  });

  it("maps tools/call only to explicit control routes and returns API errors as tool errors", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 202, body: { id: "run_1", status: "queued" } });
    const handler = createMcpHandler({ authorize: async () => true, invoke });
    const body = {
      jsonrpc: "2.0", id: "call-1", method: "tools/call",
      params: { name: "run_start", arguments: { threadId: "thr_1", prompt: "hello", idempotencyKey: "key_1" }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
    };
    const result = await read(await handler(request(body, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "run_start" })));
    expect(result.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith({ path: "/api/runs", method: "POST", body: { threadId: "thr_1", prompt: "hello", idempotencyKey: "key_1" } });
    expect(result.body.result.content[0].type).toBe("text");

    invoke.mockResolvedValueOnce({ status: 409, body: { error: "busy" } });
    const failed = await read(await handler(request(body, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "run_start" })));
    expect(failed.body.result.isError).toBe(true);
  });

  it("rejects wrong primitive types and unknown tool arguments before route invocation", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200, body: [] });
    const handler = createMcpHandler({ authorize: async () => true, invoke });
    const call = (arguments_: Record<string, unknown>) => request({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "routine_create", arguments: { botId: "bot_1", title: "T", prompt: "P", ...arguments_ }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
    }, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "routine_create" });
    const wrongNumber = await read(await handler(call({ intervalMinutes: "5" })));
    expect(wrongNumber.body.error.code).toBe(-32602);
    const unknown = await read(await handler(call({ intervalMinutes: 5, unexpected: true })));
    expect(unknown.body.error.code).toBe(-32602);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps upload_file to the multipart upload route and accepts canonical ids on run_start", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 201, body: { attachment: { id: "att_1" } } });
    const handler = createMcpHandler({ authorize: async () => true, invoke });
    const upload = { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "upload_file", arguments: { name: "note.txt", mimeType: "text/plain", contentBase64: btoa("hello") }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    const uploadResponse = await read(await handler(request(upload, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "upload_file" })));
    expect(uploadResponse.status).toBe(200);
    const uploadCall = invoke.mock.calls[0][0];
    expect(uploadCall.path).toBe("/api/uploads");
    expect(uploadCall.body).toBeInstanceOf(FormData);
    expect((uploadCall.body as FormData).get("file")).toBeInstanceOf(File);

    invoke.mockResolvedValueOnce({ status: 202, body: { id: "run_1" } });
    const run = { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "run_start", arguments: { threadId: "thr_1", prompt: "inspect", idempotencyKey: "key_1", attachments: [{ id: "att_1" }] }, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    await handler(request(run, { "MCP-Protocol-Version": MCP_MODERN_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "run_start" }));
    expect(invoke.mock.calls[1][0]).toEqual({ path: "/api/runs", method: "POST", body: { threadId: "thr_1", prompt: "inspect", idempotencyKey: "key_1", attachments: [{ id: "att_1" }] } });
  });

  it("returns 405 for GET and does not fabricate an SSE transport", async () => {
    const handler = createMcpHandler({ authorize: async () => true, invoke: vi.fn() });
    const result = await handler(new Request("https://example.test/api/mcp", { method: "GET", headers: { accept: "text/event-stream" } }));
    expect(result.status).toBe(405);
    expect(result.headers.get("content-type")).toContain("application/json");
  });
});

it("accepts a 1 MiB upload through the JSON envelope and enforces a bounded request", async () => {
  const invoke = vi.fn().mockResolvedValue({status:201,body:{attachment:{id:"att_test"}}});
  const handler = createMcpHandler({authorize:()=>true,invoke});
  const contentBase64 = Buffer.alloc(1024 * 1024, 65).toString("base64");
  const result = await handler(request({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"upload_file",arguments:{name:"test.bin",mimeType:"application/octet-stream",contentBase64}}}));
  expect(result.status).toBe(200);
  expect(invoke).toHaveBeenCalledOnce();
  expect((invoke.mock.calls[0][0].body as FormData).get("file")).toHaveProperty("size", 1024 * 1024);
  const tooLarge = await handler(request({jsonrpc:"2.0",id:1,method:"ping"},{"content-length":String(15 * 1024 * 1024)}));
  expect(tooLarge.status).toBe(413);
});
