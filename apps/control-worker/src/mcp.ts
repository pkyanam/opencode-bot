/**
 * Small, stateless MCP Streamable HTTP adapter for the control Worker.
 *
 * The route owner supplies both authentication and the existing route
 * invocation bridge. This module deliberately has no generic HTTP tool: every
 * exposed operation is an explicit, reviewed mapping to a control API route.
 * It supports the current stateless 2026-07-28 era and the legacy
 * initialize/initialized handshake used by 2025-11-25 clients. Responses are
 * JSON only; this adapter does not pretend that a JSON response is an SSE
 * stream.
 */

export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_LEGACY_VERSION = "2025-11-25";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_MODERN_VERSION, MCP_LEGACY_VERSION] as const;

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

export type McpInvokeRequest = {
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

export type McpInvokeResult = {
  status: number;
  body?: unknown;
};

export type McpHandlerOptions = {
  /** Existing owner/app-token check. It must reject missing or invalid bearer credentials. */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Existing control API bridge. It must perform the same route permissions and validation as HTTP. */
  invoke: (request: McpInvokeRequest) => McpInvokeResult | Promise<McpInvokeResult>;
  /** Optional per-request role/scope filter. Nested invoke authorization remains authoritative. */
  filterTools?: (request: Request, tools: readonly Tool[]) => readonly Tool[] | Promise<readonly Tool[]>;
  /** Validate browser Origin values. Requests without Origin are allowed for non-browser MCP clients. */
  allowOrigin?: (origin: string, request: Request) => boolean | Promise<boolean>;
  serverName?: string;
  serverVersion?: string;
};

type ToolAnnotation = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotation;
  call: (arguments_: Record<string, unknown>, invoke: McpHandlerOptions["invoke"]) => McpInvokeRequest;
};

const string = (description: string) => ({ type: "string", description });
const memoryKind = { type: "string", enum: ["fact", "preference", "decision", "lesson", "procedure", "note"], description: "Category; use fact for project context and links" };
const number = (description: string) => ({ type: "number", description });
const boolean = (description: string) => ({ type: "boolean", description });
const arrayOfStrings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const arrayOfJson = (description: string) => ({ type: "array", items: {}, description });
const jsonValue = (description: string) => ({ description });
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const idPath = (prefix: string, id: unknown) => `${prefix}/${encodeURIComponent(String(id))}`;
const queryPath = (path: string, values: Record<string, unknown>) => {
  const query = Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  return query ? `${path}?${query}` : path;
};
const bodyCall = (path: string, method: McpInvokeRequest["method"], body: Record<string, unknown>): McpInvokeRequest => ({ path, method, body });

function required(arguments_: Record<string, unknown>, key: string): unknown {
  const value = arguments_[key];
  if (value === undefined || value === null || value === "") throw new Error(`${key} is required`);
  return value;
}
function optionalBody(arguments_: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => arguments_[key] !== undefined).map((key) => [key, arguments_[key]]));
}
function uploadBody(arguments_: Record<string, unknown>): FormData {
  const name = String(required(arguments_, "name"));
  const mimeType = String(required(arguments_, "mimeType"));
  const encoded = String(required(arguments_, "contentBase64"));
  let binary: string;
  try { binary = globalThis.atob(encoded); } catch { throw new Error("contentBase64 must be valid base64"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("contentBase64 must decode to 1-10 MiB");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), name);
  return form;
}
/**
 * Decode a filesystem upload into a native Blob.  The control route forwards
 * this body as bytes to the runner; keeping the path in the query string
 * avoids an ad-hoc JSON proxy and preserves the runner's content-type.
 */
function fileUploadBody(arguments_: Record<string, unknown>): Blob {
  const encoded = String(required(arguments_, "contentBase64"));
  const mimeType = arguments_.mimeType === undefined ? "application/octet-stream" : String(arguments_.mimeType);
  let binary: string;
  try { binary = globalThis.atob(encoded); } catch { throw new Error("contentBase64 must be valid base64"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("contentBase64 must decode to 1-10 MiB");
  return new Blob([bytes], { type: mimeType });
}
function tool(name: string, description: string, properties: Record<string, unknown>, requiredKeys: string[], annotations: ToolAnnotation, call: Tool["call"]): Tool {
  return { name, description, inputSchema: objectSchema(properties, requiredKeys), annotations, call };
}
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } satisfies ToolAnnotation;
const create = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } satisfies ToolAnnotation;
const update = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } satisfies ToolAnnotation;
const remove = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } satisfies ToolAnnotation;

/** Explicit public surface. Keep this sorted so clients can cache tools/list deterministically. */
export const MCP_TOOLS: readonly Tool[] = [
  tool("bot_list", "List workspace bots.", {}, [], read, () => ({ path: "/api/bots", method: "GET" })),
  tool("bot_create", "Create a persistent workspace bot.", { name: string("Bot name"), instructions: string("Bot instructions"), model: string("Model identifier"), agent: string("Optional agent identifier"), nodeId: string("Optional owned node id") }, ["name", "instructions", "model"], create, (a) => bodyCall("/api/bots", "POST", optionalBody(a, ["name", "instructions", "model", "agent", "nodeId"]))),
  tool("bot_update", "Update a workspace bot.", { id: string("Bot id"), name: string("New name"), instructions: string("New instructions"), model: string("Model identifier"), agent: string("Agent identifier"), nodeId: string("Owned node id") }, ["id"], update, (a) => bodyCall(idPath("/api/bots", required(a, "id")), "PATCH", optionalBody(a, ["name", "instructions", "model", "agent", "nodeId"]))),
  tool("bot_delete", "Delete a workspace bot and its owned records.", { id: string("Bot id") }, ["id"], remove, (a) => ({ path: idPath("/api/bots", required(a, "id")), method: "DELETE" })),
  tool("thread_list", "List workspace threads.", {}, [], read, () => ({ path: "/api/threads", method: "GET" })),
  tool("thread_create", "Create a thread for a bot.", { botId: string("Bot id"), title: string("Thread title") }, ["botId", "title"], create, (a) => bodyCall("/api/threads", "POST", { botId: required(a, "botId"), title: required(a, "title") })),
  tool("thread_update", "Rename a thread.", { id: string("Thread id"), title: string("New title") }, ["id", "title"], update, (a) => bodyCall(idPath("/api/threads", required(a, "id")), "PATCH", { title: required(a, "title") })),
  tool("thread_delete", "Delete a thread.", { id: string("Thread id") }, ["id"], remove, (a) => ({ path: idPath("/api/threads", required(a, "id")), method: "DELETE" })),
  tool("thread_messages", "Read the public transcript for a thread.", { threadId: string("Thread id") }, ["threadId"], read, (a) => ({ path: idPath("/api/threads", required(a, "threadId")) + "/messages", method: "GET" })),
  tool("thread_action", "Run an explicit native command or session action on a thread.", { threadId: string("Thread id"), command: string("Native command name"), text: string("Command text"), messageID: string("Message id for undo"), files: boolean("Whether undo includes files"), sessionAction: jsonValue("Native session action object"), idempotencyKey: string("Unique idempotency key") }, ["threadId", "idempotencyKey"], create, (a) => bodyCall(idPath("/api/threads", required(a, "threadId")) + "/action", "POST", optionalBody(a, ["command", "text", "messageID", "files", "sessionAction", "idempotencyKey"]))),
  tool("bot_skills", "List skills assigned to a bot.", { botId: string("Bot id") }, ["botId"], read, (a) => ({ path: idPath("/api/bots", required(a, "botId")) + "/skills", method: "GET" })),
  tool("bot_skills_assign", "Replace the skills assigned to a bot.", { botId: string("Bot id"), skillIds: arrayOfStrings("Skill ids") }, ["botId", "skillIds"], update, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/skills", "PUT", { skillIds: required(a, "skillIds") })),
  tool("run_list", "List recent runs.", {}, [], read, () => ({ path: "/api/runs", method: "GET" })),
  tool("run_start", "Start a prompt run. Use a fresh idempotency key for each intentional submission.", { threadId: string("Thread id"), prompt: string("Prompt text"), idempotencyKey: string("Unique idempotency key"), commandName: string("Optional native command"), commandText: string("Optional command text"), attachments: arrayOfJson("Uploaded attachment ids or references, at most eight") }, ["threadId", "prompt", "idempotencyKey"], create, (a) => bodyCall("/api/runs", "POST", optionalBody(a, ["threadId", "prompt", "idempotencyKey", "commandName", "commandText", "attachments"]))),
  tool("run_get", "Get a run, public lifecycle events, and pending approval.", { id: string("Run id") }, ["id"], read, (a) => ({ path: idPath("/api/runs", required(a, "id")), method: "GET" })),
  tool("run_events", "Read the public event snapshot for a run.", { id: string("Run id") }, ["id"], read, (a) => ({ path: idPath("/api/runs", required(a, "id")) + "/events", method: "GET" })),
  tool("run_cancel", "Cancel a run that is still active.", { id: string("Run id") }, ["id"], remove, (a) => ({ path: idPath("/api/runs", required(a, "id")) + "/cancel", method: "POST" })),
  tool("run_approve", "Approve or deny a pending run action. Human confirmation is required by the caller.", { id: string("Run id"), requestId: string("Approval request id"), decision: { ...string("Approval decision"), enum: ["approve", "deny"] } }, ["id", "requestId", "decision"], { ...remove, destructiveHint: true }, (a) => bodyCall(idPath("/api/runs", required(a, "id")) + "/approval", "POST", { requestId: required(a, "requestId"), decision: required(a, "decision") })),
  tool("delegation_list", "List delegations for a thread.", { threadId: string("Source thread id") }, ["threadId"], read, (a) => ({ path: idPath("/api/threads", required(a, "threadId")) + "/delegations", method: "GET" })),
  tool("delegation_create", "Delegate work to another bot thread.", { threadId: string("Source thread id"), targetBotId: string("Target bot id"), prompt: string("Delegated prompt"), idempotencyKey: string("Unique idempotency key"), sourceRunId: string("Optional source run id") }, ["threadId", "targetBotId", "prompt", "idempotencyKey"], create, (a) => bodyCall(idPath("/api/threads", required(a, "threadId")) + "/delegations", "POST", optionalBody(a, ["targetBotId", "prompt", "idempotencyKey", "sourceRunId"]))),
  tool("skill_list", "List reusable skills.", {}, [], read, () => ({ path: "/api/skills", method: "GET" })),
  tool("skill_create", "Create a reusable skill.", { name: string("Skill name"), description: string("Description"), instructions: string("Instructions") }, ["name", "description", "instructions"], create, (a) => bodyCall("/api/skills", "POST", { name: required(a, "name"), description: required(a, "description"), instructions: required(a, "instructions") })),
  tool("skill_update", "Update a reusable skill.", { id: string("Skill id"), name: string("Skill name"), description: string("Description"), instructions: string("Instructions") }, ["id", "name", "description", "instructions"], update, (a) => bodyCall(idPath("/api/skills", required(a, "id")), "PATCH", { name: required(a, "name"), description: required(a, "description"), instructions: required(a, "instructions") })),
  tool("skill_delete", "Delete a reusable skill.", { id: string("Skill id") }, ["id"], remove, (a) => ({ path: idPath("/api/skills", required(a, "id")), method: "DELETE" })),
  tool("plugin_list", "List installed OpenCode plugins.", {}, [], read, () => ({ path: "/api/extensions/plugins", method: "GET" })),
  tool("plugin_install", "Install a declared OpenCode plugin package.", { package: string("Package specifier") }, ["package"], create, (a) => bodyCall("/api/extensions/plugins", "POST", { package: required(a, "package") })),
  tool("plugin_remove", "Remove an installed OpenCode plugin package.", { package: string("Package specifier") }, ["package"], remove, (a) => bodyCall("/api/extensions/plugins", "DELETE", { package: required(a, "package") })),
  tool("catalog_get", "Read the live OpenCode model, agent, command, and MCP catalog.", {}, [], read, () => ({ path: "/api/catalog", method: "GET" })),
  tool("extension_repository_list", "List saved extension repositories.", {}, [], read, () => ({ path: "/api/extension-repositories", method: "GET" })),
  tool("extension_repository_add", "Save an extension repository URL.", { url: string("Repository URL") }, ["url"], create, (a) => bodyCall("/api/extension-repositories", "POST", { url: required(a, "url") })),
  tool("extension_repository_tree", "List files in a saved extension repository.", { id: string("Repository id"), path: string("Optional repository path") }, ["id"], read, (a) => ({ path: queryPath(idPath("/api/extension-repositories", required(a, "id")) + "/tree", { path: a.path }), method: "GET" })),
  tool("extension_repository_preview", "Preview a file in a saved extension repository.", { id: string("Repository id"), path: string("Repository file path") }, ["id", "path"], read, (a) => ({ path: queryPath(idPath("/api/extension-repositories", required(a, "id")) + "/preview", { path: required(a, "path") }), method: "GET" })),
  tool("extension_repository_install", "Install a skill from a saved extension repository.", { id: string("Repository id"), skillPath: string("Skill path") }, ["id", "skillPath"], create, (a) => bodyCall(idPath("/api/extension-repositories", required(a, "id")) + "/install", "POST", { skillPath: required(a, "skillPath") })),
  tool("file_list", "List safe workspace artifacts.", { path: string("Optional relative path"), limit: number("Optional result limit") }, [], read, (a) => ({ path: queryPath("/api/files", { path: a.path ?? ".", limit: a.limit }), method: "GET" })),
  tool("file_read", "Download a safe workspace artifact.", { path: string("Relative artifact path") }, ["path"], read, (a) => ({ path: queryPath("/api/files/content", { path: required(a, "path") }), method: "GET" })),
  tool("file_write", "Upload a bounded text workspace artifact.", { path: string("Relative artifact path"), content: string("UTF-8 file content") }, ["path", "content"], { ...create, destructiveHint: true }, (a) => ({ path: queryPath("/api/files", { path: required(a, "path") }), method: "POST", body: required(a, "content") })),
  tool("file_upload", "Upload a bounded binary workspace artifact from base64 content.", { path: string("Relative artifact path"), contentBase64: string("Base64 file content, at most 10 MiB decoded"), mimeType: string("Optional MIME type") }, ["path", "contentBase64"], { ...create, destructiveHint: true }, (a) => ({ path: queryPath("/api/files", { path: required(a, "path") }), method: "POST", body: fileUploadBody(a) })),
  tool("file_mkdir", "Create a workspace directory, including missing parent directories.", { path: string("Relative directory path") }, ["path"], { ...create, idempotentHint: true }, (a) => ({ path: queryPath("/api/files/mkdir", { path: required(a, "path") }), method: "POST" })),
  tool("file_move", "Move a workspace file or directory to a new relative path.", { from: string("Existing relative path"), to: string("Destination relative path") }, ["from", "to"], { ...update, destructiveHint: true }, (a) => ({ path: queryPath("/api/files/move", { from: required(a, "from"), to: required(a, "to") }), method: "POST" })),
  tool("file_delete", "Delete a workspace file or directory recursively.", { path: string("Relative path to delete") }, ["path"], remove, (a) => ({ path: queryPath("/api/files", { path: required(a, "path") }), method: "DELETE" })),
  tool("upload_file", "Upload a bounded chat attachment from base64 content and return its canonical attachment id.", { name: string("File name"), mimeType: string("MIME type"), contentBase64: string("Base64 file content, at most 10 MiB decoded") }, ["name", "mimeType", "contentBase64"], { ...create, destructiveHint: false }, (a) => ({ path: "/api/uploads", method: "POST", body: uploadBody(a) })),
  tool("attachment_read", "Download a previously uploaded chat attachment.", { id: string("Attachment id") }, ["id"], read, (a) => ({ path: idPath("/api/uploads", required(a, "id")), method: "GET" })),
  tool("computer_readiness", "Get computer startup readiness.", {}, [], read, () => ({ path: "/api/computer/readiness", method: "GET" })),
  tool("computer_sleep", "Save and verify a durable checkpoint, then stop the idle Cloudflare Computer. Blocks active work and manual control. Owner access required.", {}, [], update, () => bodyCall("/api/computer/sleep", "POST", {})),
  tool("computer_wake", "Wake a deliberately sleeping Computer and restore its verified checkpoint.", {}, [], update, () => bodyCall("/api/computer/wake", "POST", {})),
  tool("storage_usage", "Inspect this deployment's measured R2 object usage, backup retention policy, and protected checkpoint objects. Does not wake the Computer. Owner access required.", {}, [], read, () => ({ path: "/api/storage", method: "GET" })),
  tool("computer_status", "Get computer status and checkpoint metadata.", {}, [], read, () => ({ path: "/api/computer/status", method: "GET" })),
  tool("checkpoint_create", "Create a computer checkpoint.", {}, [], create, () => ({ path: "/api/computer/checkpoint", method: "POST" })),
  tool("checkpoint_restore", "Restore a computer checkpoint.", { checkpointId: string("Optional checkpoint id") }, [], { ...update, destructiveHint: true }, (a) => bodyCall("/api/computer/restore", "POST", optionalBody(a, ["checkpointId"]))),
  tool("node_list", "List registered computer nodes and heartbeat availability.", {}, [], read, () => ({ path: "/api/nodes", method: "GET" })),
  tool("node_pairing_create", "Create a short-lived single-use computer node pairing token.", { label: string("Optional node label"), ttlMs: number("Optional lifetime in milliseconds") }, [], create, (a) => bodyCall("/api/nodes/pairing", "POST", optionalBody(a, ["label", "ttlMs"]))),
  tool("node_revoke", "Revoke a registered computer node secret.", { id: string("Node id") }, ["id"], remove, (a) => ({ path: idPath("/api/nodes", required(a, "id")) + "/revoke", method: "POST" })),
  tool("pairing_session", "Read the authenticated paired-client session and allowed workspace scope.", {}, [], read, () => ({ path: "/api/pairing/session/me", method: "GET" })),
  tool("routine_list", "List scheduled routines.", {}, [], read, () => ({ path: "/api/routines", method: "GET" })),
  tool("routine_create", "Create a scheduled routine.", { botId: string("Bot id"), title: string("Routine title"), prompt: string("Routine prompt"), intervalMinutes: number("Minimum five minute interval"), enabled: boolean("Whether enabled") }, ["botId", "title", "prompt", "intervalMinutes"], create, (a) => bodyCall("/api/routines", "POST", optionalBody(a, ["botId", "title", "prompt", "intervalMinutes", "enabled"]))),
  tool("routine_update", "Enable or disable a routine.", { id: string("Routine id"), enabled: boolean("Whether enabled") }, ["id", "enabled"], update, (a) => bodyCall(idPath("/api/routines", required(a, "id")), "PATCH", { enabled: required(a, "enabled") })),
  tool("routine_delete", "Delete a scheduled routine.", { id: string("Routine id") }, ["id"], remove, (a) => ({ path: idPath("/api/routines", required(a, "id")), method: "DELETE" })),
  tool("memory_list", "List memory items for a bot.", { botId: string("Bot id") }, ["botId"], read, (a) => ({ path: idPath("/api/bots", required(a, "botId")) + "/memory", method: "GET" })),
  tool("memory_add", "Add a memory item for a bot.", { botId: string("Bot id"), content: string("Memory content") }, ["botId", "content"], create, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/memory", "POST", { content: required(a, "content") })),
  tool("memory_delete", "Delete a bot memory item.", { botId: string("Bot id"), memoryId: string("Memory id") }, ["botId", "memoryId"], remove, (a) => ({ path: idPath("/api/bots", required(a, "botId")) + "/memory/" + encodeURIComponent(String(required(a, "memoryId"))), method: "DELETE" })),
  tool("memory_search", "Search the workspace memory registry; filter by bot to include its own and shared memories.", { botId: string("Optional bot ID"), query: string("Search words"), limit: number("Maximum 200"), offset: number("Pagination offset") }, [], read, a => ({path:queryPath("/api/memory",{botId:a.botId,q:a.query,limit:a.limit,offset:a.offset}),method:"GET"})),
  tool("memory_read", "Read a workspace memory with sharing and provenance.", {id:string("Memory ID")}, ["id"], read,a=>({path:idPath("/api/memory",required(a,"id")),method:"GET"})),
  tool("memory_remember", "Create a durable memory owned by a bot, optionally shared across computers.", {botId:string("Author bot ID"),title:string("Title"),content:string("Memory content"),kind:memoryKind,tags:arrayOfStrings("Tags"),visibility:string("private, shared, workspace"),sharedBotIds:arrayOfStrings("Recipient bot IDs")},["botId","content"],create,a=>bodyCall("/api/memory","POST",optionalBody(a,["botId","title","content","kind","tags","visibility","sharedBotIds"]))),
  tool("memory_update", "Correct or change sharing on a memory. Read its latest revision first.",{id:string("Memory ID"),revision:number("Current revision"),title:string("Title"),content:string("Content"),kind:memoryKind,tags:arrayOfStrings("Tags"),visibility:string("private, shared, workspace"),sharedBotIds:arrayOfStrings("Recipient bot IDs"),pinned:boolean("Always recall this memory")},["id","revision"],update,a=>bodyCall(idPath("/api/memory",required(a,"id")),"PATCH",optionalBody(a,["revision","title","content","kind","tags","visibility","sharedBotIds","pinned"]))),
  tool("memory_history", "Read the last 20 versions of a workspace memory.",{id:string("Memory ID")},["id"],read,a=>({path:idPath("/api/memory",required(a,"id"))+"/history",method:"GET"})),
  tool("memory_forget", "Delete a memory including its search index and revision history.",{id:string("Memory ID"),revision:number("Current revision")},["id","revision"],remove,a=>({path:queryPath(idPath("/api/memory",required(a,"id")),{revision:required(a,"revision")}),method:"DELETE"})),
  tool("memory_retain", "Retain durable information through the configured memory provider; equivalent to memory_remember.",{botId:string("Author bot ID"),content:string("Memory content"),title:string("Optional title"),kind:memoryKind,tags:arrayOfStrings("Optional search tags"),visibility:string("Optional visibility"),sharedBotIds:arrayOfStrings("Optional recipient bot IDs")},["botId","content"],create,a=>bodyCall("/api/memory","POST",optionalBody(a,["botId","content","title","kind","tags","visibility","sharedBotIds"]))),
  tool("memory_recall", "Recall relevant memories through the configured memory provider.",{botId:string("Bot ID whose authorized memories should be recalled"),query:string("Recall query"),budget:string("low, mid, or high")},["botId","query"],read,a=>bodyCall("/api/memory/recall","POST",optionalBody(a,["botId","query","budget"]))),
  tool("memory_reflect", "Reflect on relevant memories through the configured memory provider.",{botId:string("Bot ID whose authorized memories should be used"),query:string("Reflection question"),budget:string("low, mid, or high")},["botId","query"],read,a=>bodyCall("/api/memory/reflect","POST",optionalBody(a,["botId","query","budget"]))),
  tool("memory_observations", "Inspect provider observations for a bot.",{botId:string("Bot ID whose observations should be read")},["botId"],read,a=>({path:queryPath("/api/memory/observations",{botId:a.botId}),method:"GET"})),
  tool("memory_mental_models", "List provider mental models for a bot.",{botId:string("Bot ID whose mental models should be read")},["botId"],read,a=>({path:queryPath("/api/memory/mental-models",{botId:a.botId}),method:"GET"})),
  tool("memory_mental_model_create", "Create a provider mental model.",{botId:string("Owning bot ID"),name:string("Mental model name"),query:string("Description or source query")},["botId","name","query"],create,a=>bodyCall("/api/memory/mental-models","POST",optionalBody(a,["botId","name","query"]))),
  tool("memory_mental_model_delete", "Delete a provider mental model by ID.",{botId:string("Owning bot ID"),id:string("Mental model ID")},["botId","id"],remove,a=>({path:queryPath(idPath("/api/memory/mental-models",required(a,"id")),{botId:a.botId}),method:"DELETE"})),
  tool("memory_mental_model_refresh", "Refresh a provider mental model by ID.",{botId:string("Owning bot ID"),id:string("Mental model ID")},["botId","id"],update,a=>bodyCall(idPath("/api/memory/mental-models",required(a,"id"))+"/refresh","POST",{botId:required(a,"botId")})),
  tool("provider_list", "List provider connection metadata without credentials.", {}, [], read, () => ({ path: "/api/providers", method: "GET" })),
  tool("telegram_status", "Read Telegram configuration, pairings, and channel health for a bot.", { botId: string("Bot id") }, ["botId"], read, (a) => ({ path: idPath("/api/bots", required(a, "botId")) + "/telegram", method: "GET" })),
  tool("telegram_configure", "Configure Telegram delivery for a bot.", { botId: string("Bot id"), token: string("Bot token"), transport: string("polling or webhook"), webhookUrl: string("Webhook URL") }, ["botId", "token", "transport"], update, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/telegram/configure", "POST", optionalBody(a, ["token", "transport", "webhookUrl"]))),
  tool("telegram_pairing_create", "Create a Telegram account pairing link for a bot.", { botId: string("Bot id") }, ["botId"], create, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/telegram/pairing", "POST", {})),
  tool("telegram_pairing_revoke", "Revoke a Telegram chat pairing.", { botId: string("Bot id"), chatId: string("Telegram chat id"), telegramUserId: string("Telegram user id") }, ["botId", "chatId", "telegramUserId"], remove, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/telegram/unlink", "POST", { chatId: required(a, "chatId"), telegramUserId: required(a, "telegramUserId") })),
  tool("telegram_commands_refresh", "Refresh the Telegram command menu for a bot.", { botId: string("Bot id") }, ["botId"], update, (a) => bodyCall(idPath("/api/bots", required(a, "botId")) + "/telegram/commands", "POST", {})),
  tool("device_list", "List paired trusted clients; never returns their bearer secrets.", {}, [], read, () => ({ path: "/api/pairing/devices", method: "GET" })),
  tool("device_invite", "Create a one-use device invitation. Treat returned code and QR secret as credentials.", { label: string("Invitation label"), ttlMs: number("Lifetime in milliseconds") }, [], create, a => bodyCall("/api/pairing/invites", "POST", optionalBody(a, ["label", "ttlMs"]))),
  tool("device_revoke", "Revoke a paired client's credential.", { id: string("Device id") }, ["id"], remove, a => ({ path: idPath("/api/pairing/devices", required(a, "id")) + "/revoke", method: "POST" })),
  tool("device_invite_cancel", "Cancel an unused device invitation.", { id: string("Invitation id") }, ["id"], remove, a => ({ path: idPath("/api/pairing/invites", required(a, "id")), method: "DELETE" })),
  tool("update_status", "Check application release and update progress.", {}, [], read, () => ({ path: "/api/updates", method: "GET" })),
  tool("update_start", "Update the application and computer to a released version. May interrupt availability.", { version: string("Release version") }, ["version"], { ...create, destructiveHint: true }, a => bodyCall("/api/updates", "POST", { version: required(a, "version") })),
  tool("update_recover", "Recover a stalled application update.", {}, [], update, () => ({ path: "/api/updates/recover", method: "POST" })),
  tool("update_configure", "Configure Cloudflare deployment credentials for application updates. Secret is not returned.", { accountId: string("Cloudflare account id"), workerName: string("This installation's Worker name"), token: string("Scoped Cloudflare API token") }, ["accountId", "workerName", "token"], update, a => bodyCall("/api/updates/configure", "POST", optionalBody(a, ["accountId", "workerName", "token"]))),
  tool("update_disconnect", "Remove stored updater deployment credentials.", {}, [], remove, () => ({ path: "/api/updates/configure", method: "DELETE" })),
  tool("provider_configure", "Invoke an explicitly supported provider configuration operation. Credentials are passed only to the existing authenticated provider route.", { operation: string("Supported operation path suffix"), credentialID: string("Credential id for activate, label, or remove"), integrationID: string("Integration id"), providerID: string("Provider id"), key: string("Provider key"), label: string("Credential label"), directory: string("Optional directory"), methodID: string("OAuth or command method id"), attemptID: string("OAuth or command attempt id"), answer: jsonValue("Provider form answer"), code: string("OAuth completion code"), name: string("Custom provider name"), baseURL: string("Custom provider base URL"), modelIDs: arrayOfStrings("Custom provider model ids"), models: jsonValue("Custom provider model map"), apiKey: string("Custom provider API key"), packageName: string("Custom provider package"), settings: jsonValue("Custom provider settings"), headers: jsonValue("Custom provider headers"), body: jsonValue("Custom provider request body"), restart: boolean("Whether to restart the runtime") }, ["operation"], { ...create, idempotentHint: false }, (a) => {
    const operation = String(required(a, "operation"));
    const allowed = new Set(["key", "custom", "credentials/activate", "credentials/label", "credentials/remove", "oauth/start", "oauth/status", "oauth/complete", "oauth/cancel", "command/start", "command/status", "command/cancel"]);
    if (!allowed.has(operation)) throw new Error("unsupported provider operation");
    return bodyCall(`/api/providers/${operation}`, "POST", optionalBody(a, ["credentialID", "integrationID", "providerID", "key", "label", "directory", "methodID", "attemptID", "answer", "code", "name", "baseURL", "modelIDs", "models", "apiKey", "packageName", "settings", "headers", "body", "restart"]));
  }),
].slice().sort((a, b) => a.name.localeCompare(b.name));

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } };
}
function jsonRpcResult(id: JsonRpcId, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
function textResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  return { resultType: "complete", content: [{ type: "text", text: text ?? "" }], ...(structuredContent === undefined ? {} : { structuredContent }) };
}
function errorToolResult(message: string, value?: unknown) {
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  return { resultType: "complete", isError: true, content: [{ type: "text", text: message }], ...(structuredContent === undefined ? {} : { structuredContent }) };
}
function protocolVersion(request: Request, body: JsonRpcRequest): string | undefined {
  const header = request.headers.get("MCP-Protocol-Version") ?? undefined;
  const meta = (body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>)._meta : undefined);
  const version = meta && typeof meta === "object" ? (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"] : undefined;
  if (header && typeof version === "string" && header !== version) throw new ProtocolError(400, "HeaderMismatch", -32020);
  return header ?? (typeof version === "string" ? version : undefined);
}
class ProtocolError extends Error { constructor(public status: number, message: string, public code: number, public data?: unknown) { super(message); } }

function checkModernHeaders(request: Request, body: JsonRpcRequest, version: string) {
  if (version !== MCP_MODERN_VERSION) return;
  if (request.headers.get("MCP-Protocol-Version") !== MCP_MODERN_VERSION) throw new ProtocolError(400, "HeaderMismatch: MCP-Protocol-Version is required", -32020);
  const method = request.headers.get("Mcp-Method");
  if (method !== body.method) throw new ProtocolError(400, "HeaderMismatch: Mcp-Method does not match request", -32020);
  if (["tools/call"].includes(String(body.method))) {
    const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : "";
    if (decodeHeaderValue(request.headers.get("Mcp-Name")) !== name) throw new ProtocolError(400, "HeaderMismatch: Mcp-Name does not match request", -32020);
  }
}

function decodeHeaderValue(value: string | null): string | null {
  if (value === null || !value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  try {
    const binary = globalThis.atob(encoded);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { throw new ProtocolError(400, "HeaderMismatch: invalid base64 header value", -32020); }
}

function validateModernMetadata(body: JsonRpcRequest, version: string) {
  if (version !== MCP_MODERN_VERSION) return;
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {};
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new ProtocolError(400, "Missing required request metadata", -32000, { required: ["io.modelcontextprotocol/protocolVersion", "io.modelcontextprotocol/clientInfo", "io.modelcontextprotocol/clientCapabilities"] });
  const metadata = meta as Record<string, unknown>;
  const info = metadata["io.modelcontextprotocol/clientInfo"];
  const capabilities = metadata["io.modelcontextprotocol/clientCapabilities"];
  if (metadata["io.modelcontextprotocol/protocolVersion"] !== MCP_MODERN_VERSION || !info || typeof info !== "object" || Array.isArray(info) || typeof (info as Record<string, unknown>).name !== "string" || typeof (info as Record<string, unknown>).version !== "string" || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities))
    throw new ProtocolError(400, "Missing or invalid request metadata", -32000, { required: ["io.modelcontextprotocol/protocolVersion", "io.modelcontextprotocol/clientInfo", "io.modelcontextprotocol/clientCapabilities"] });
}

function validateToolArguments(toolDefinition: Tool, arguments_: Record<string, unknown>) {
  const schema = toolDefinition.inputSchema;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in arguments_) || arguments_[key] === undefined || arguments_[key] === null)
      throw new ProtocolError(400, `Missing required argument: ${key}`, -32602);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(arguments_)) if (!(key in properties))
      throw new ProtocolError(400, `Unknown argument: ${key}`, -32602);
  }
  for (const [key, value] of Object.entries(arguments_)) {
    const expected = properties[key]?.type;
    if (!expected || value === null || value === undefined) continue;
    const valid = expected === "string" ? typeof value === "string"
      : expected === "number" ? typeof value === "number" && Number.isFinite(value)
      : expected === "boolean" ? typeof value === "boolean"
      : expected === "array" ? Array.isArray(value) && (() => {
        const items = properties[key]?.items as Record<string, unknown> | undefined;
        if (!items || Object.keys(items).length === 0) return true;
        if (items.type === "string") return value.every((item) => typeof item === "string");
        if (items.type === "object") return value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
        return true;
      })()
      : expected === "object" ? typeof value === "object" && !Array.isArray(value)
      : true;
    if (!valid) throw new ProtocolError(400, `Argument ${key} must be ${expected}`, -32602);
  }
}

async function readJson(request: Request): Promise<JsonRpcRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new ProtocolError(415, "Content-Type must be application/json", -32700);
  // Base64 adds a third to a 10 MiB upload, plus the JSON envelope.
  const maxBytes = 14 * 1024 * 1024;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new ProtocolError(413, "JSON-RPC request is too large", -32600);
  const reader = request.body?.getReader();
  if (!reader) throw new ProtocolError(400, "Request body is required", -32600);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ProtocolError(413, "JSON-RPC request is too large", -32600); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProtocolError(400, "Invalid JSON-RPC request", -32600);
    return parsed as JsonRpcRequest;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(400, "Invalid JSON", -32700);
  }
}

/** Create a POST-only MCP endpoint. The root route should pass its bearer check as authorize. */
export function createMcpHandler(options: McpHandlerOptions) {
  return async function handleMcp(request: Request): Promise<Response> {
    if (!(await options.authorize(request))) return response({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (request.method !== "POST") return response({ error: "MCP endpoint accepts POST only" }, 405, { allow: "POST" });
    const origin = request.headers.get("origin");
    if (origin && !(await (options.allowOrigin ? options.allowOrigin(origin, request) : origin === new URL(request.url).origin))) return response({ error: "invalid origin" }, 403);
    const accept = request.headers.get("accept") ?? "";
    if (!/application\/json/i.test(accept) || !/text\/event-stream/i.test(accept))
      return response({ error: "Accept must include application/json and text/event-stream" }, 406);
    let body: JsonRpcRequest;
    try { body = await readJson(request); } catch (error) {
      const e = error instanceof ProtocolError ? error : new ProtocolError(400, "Invalid request", -32600);
      return response(jsonRpcError(undefined, e.code, e.message, e.data), e.status);
    }
    const id = body.id;
    const isNotification = id === undefined;
    try {
      if (body.jsonrpc !== "2.0" || typeof body.method !== "string") throw new ProtocolError(400, "Invalid JSON-RPC request", -32600);
      if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") throw new ProtocolError(400, "Invalid JSON-RPC id", -32600);
      const version = protocolVersion(request, body);
      if (version && !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(version as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number]))
        throw new ProtocolError(400, "Unsupported protocol version", -32022, { supported: MCP_SUPPORTED_PROTOCOL_VERSIONS, requested: version });
      checkModernHeaders(request, body, version ?? MCP_LEGACY_VERSION);
      validateModernMetadata(body, version ?? MCP_LEGACY_VERSION);
      if (body.method === "initialize") {
        if (isNotification) throw new ProtocolError(400, "initialize requires a request id", -32600);
        const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_LEGACY_VERSION;
        const selected = requested === MCP_MODERN_VERSION ? MCP_LEGACY_VERSION : (MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number]) ? requested : MCP_LEGACY_VERSION);
        return response(jsonRpcResult(id ?? null, { protocolVersion: selected, capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.serverName ?? "opencode-bot", version: options.serverVersion ?? "0.1.0" } }));
      }
      if (isNotification && version === MCP_MODERN_VERSION) throw new ProtocolError(400, "Modern client notifications are not supported", -32600);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (isNotification && ["server/discover", "tools/list", "tools/call"].includes(body.method)) throw new ProtocolError(400, "Notifications are not supported for this method", -32600);
      if (body.method === "ping") return isNotification ? new Response(null, { status: 202 }) : response(jsonRpcResult(id!, {}));
      if (body.method === "server/discover") return response(jsonRpcResult(id ?? null, { protocolVersions: [MCP_MODERN_VERSION], capabilities: { tools: { listChanged: false } }, serverInfo: { name: options.serverName ?? "opencode-bot", version: options.serverVersion ?? "0.1.0" } }));
      if (body.method === "tools/list") {
        const visibleTools = options.filterTools ? await options.filterTools(request, MCP_TOOLS) : MCP_TOOLS;
        return response(jsonRpcResult(id ?? null, { tools: visibleTools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })), resultType: "complete", ttlMs: 30_000, cacheScope: "private" }));
      }
      if (body.method !== "tools/call") throw new ProtocolError(404, "Method not found", -32601);
      if (isNotification) throw new ProtocolError(400, "Mutating tools/call notifications are not supported", -32600);
      const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
      if (typeof params.name !== "string" || !params.name) throw new ProtocolError(400, "Tool name is required", -32602);
      const visibleTools = options.filterTools ? await options.filterTools(request, MCP_TOOLS) : MCP_TOOLS;
      const selected = visibleTools.find((candidate) => candidate.name === params.name);
      if (!selected) throw new ProtocolError(404, `Unknown tool: ${params.name}`, -32602);
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new ProtocolError(400, "Tool arguments must be an object", -32602);
      validateToolArguments(selected, args as Record<string, unknown>);
      let invocation: McpInvokeRequest;
      try { invocation = selected.call(args as Record<string, unknown>, options.invoke); } catch (error) { return response(jsonRpcResult(id ?? null, errorToolResult(error instanceof Error ? error.message : String(error)))); }
      const result = await options.invoke(invocation);
      if (result.status >= 400) return response(jsonRpcResult(id ?? null, errorToolResult(`Control API returned HTTP ${result.status}`, result.body)));
      return response(jsonRpcResult(id ?? null, textResult(result.body)));
    } catch (error) {
      const e = error instanceof ProtocolError ? error : new ProtocolError(500, "Internal MCP error", -32603);
      return response(jsonRpcError(id, e.code, e.message, e.data), e.status);
    }
  };
}
