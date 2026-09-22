import { clearConnection, readToken } from "./storage";
import { File as ExpoFile } from "expo-file-system";
import type {
  Approval,
  Attachment,
  Bot,
  Message,
  Run,
  RunEvent,
  State,
  Thread,
  Catalog,
  FileArtifact,
  Skill,
  MemoryItem,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
  }
}
let cachedToken: string | null | undefined;
const authInvalidated = new Set<() => void>();
export const setCachedToken = (value: string | null) => {
  cachedToken = value;
};
export const onAuthInvalidated = (listener: () => void) => {
  authInvalidated.add(listener);
  return () => {
    authInvalidated.delete(listener);
  };
};
async function token() {
  if (cachedToken === undefined) cachedToken = await readToken();
  return cachedToken;
}
export async function request<T>(
  baseUrl: string,
  path: string,
  init: MobileRequestInit = {},
): Promise<T> {
  const {
    auth: includeAuth = true,
    timeoutMs = 30_000,
    responseType = "json",
    ...fetchInit
  } = init;
  const url = normalizeBaseUrl(baseUrl);
  const authToken = await token();
  const headers = new Headers(fetchInit.headers);
  headers.set("Accept", responseType === "text" ? "text/plain, */*" : "application/json");
  if (fetchInit.body && !(fetchInit.body instanceof FormData) && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (includeAuth && authToken)
    headers.set("Authorization", `Bearer ${authToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = fetchInit.signal;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      ...fetchInit,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted)
      throw new ApiError("The workspace request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    const raw = await response.text();
    let message = response.status >= 500 ? `The workspace server returned an error (${response.status}). It will reconnect automatically.` : `Request failed (${response.status}).`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        error?: string;
        message?: string;
        code?: string;
        title?: string;
      };
      const detail = parsed.error ?? parsed.message ?? parsed.title;
      if (typeof detail === "string" && detail.length <= 500) message = detail;
      code = parsed.code;
    } catch {}
    if (response.status === 401 && includeAuth) {
      cachedToken = null;
      await clearConnection();
      authInvalidated.forEach((listener) => listener());
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (responseType === "text" ? response.text() : response.json()) as Promise<T>;
}

type MobileRequestInit = RequestInit & {
  auth?: boolean;
  timeoutMs?: number;
  responseType?: "json" | "text";
};
export const api = (baseUrl: string) => ({
  state: () => request<State>(baseUrl, "/api/state"),
  bots: () => request<Bot[]>(baseUrl, "/api/bots"),
  createBot: (
    payload:
      | {
          name: string;
          instructions?: string;
          model?: string;
          agent?: string;
          nodeId?: string;
        }
      | string,
  ) => {
    const body =
      typeof payload === "string"
        ? { name: payload, instructions: "", model: "" }
        : { instructions: "", model: "", ...payload };
    return request<Bot>(baseUrl, "/api/bots", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  updateBot: (
    id: string,
    payload: Partial<Pick<Bot, "name" | "instructions" | "model" | "agent">>,
  ) =>
    request<Bot>(baseUrl, `/api/bots/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteBot: (id: string) =>
    request<void>(baseUrl, `/api/bots/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  redeem: (credential: string, deviceName: string) =>
    request<{ deviceToken: string }>(baseUrl, "/api/pairing/redeem", {
      method: "POST",
      auth: false,
      body: JSON.stringify({
        ...(credential.startsWith("ps_")
          ? { secret: credential }
          : { code: credential }),
        deviceName,
        clientType: "expo",
      }),
    }),
  session: () =>
    request<{ role: string; deviceId?: string; deviceName?: string }>(
      baseUrl,
      "/api/pairing/session/me",
    ),
  createThread: (botId: string, title: string) =>
    request<Thread>(baseUrl, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ botId, title }),
    }),
  renameThread: (threadId: string, title: string) =>
    request<Thread>(baseUrl, `/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteThread: (threadId: string) =>
    request<void>(baseUrl, `/api/threads/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    }),
  catalog: () => request<Catalog>(baseUrl, "/api/catalog"),
  skills: () => request<Skill[]>(baseUrl, "/api/skills"),
  createSkill: (
    payload: Pick<Skill, "name" | "description" | "instructions">,
  ) =>
    request<Skill>(baseUrl, "/api/skills", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateSkill: (
    id: string,
    payload: Pick<Skill, "name" | "description" | "instructions">,
  ) =>
    request<Skill>(baseUrl, `/api/skills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteSkill: (id: string) =>
    request<void>(baseUrl, `/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  memories: (params: { botId?: string; q?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.botId) query.set("botId", params.botId);
    if (params.q) query.set("q", params.q);
    query.set("limit", String(params.limit ?? 100));
    query.set("offset", String(params.offset ?? 0));
    return request<MemoryItem[]>(baseUrl, `/api/memory?${query.toString()}`);
  },
  createMemory: (payload: { botId: string | null; content: string; title?: string; kind?: string; tags?: string[]; visibility?: string; sharedBotIds?: string[] }) =>
    request<MemoryItem>(baseUrl, "/api/memory", { method: "POST", body: JSON.stringify(payload) }),
  updateMemory: (id: string, payload: { revision: number; content?: string; title?: string; kind?: string; tags?: string[]; visibility?: string; sharedBotIds?: string[]; pinned?: boolean }) =>
    request<MemoryItem>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteMemory: (id: string, revision: number) =>
    request<void>(baseUrl, `/api/memory/${encodeURIComponent(id)}?revision=${encodeURIComponent(String(revision))}`, { method: "DELETE" }),
  files: (path = ".") =>
    request<{ artifacts?: FileArtifact[] } | FileArtifact[]>(
      baseUrl,
      `/api/files?path=${encodeURIComponent(path)}`,
    ),
  fileContent: (path: string) =>
    request<string>(
      baseUrl,
      `/api/files/content?path=${encodeURIComponent(path)}`,
      { responseType: "text" },
    ),
  messages: async (threadId: string) => {
    const result = await request<{ messages: Message[] }>(
      baseUrl,
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
    );
    return {
      ...result,
      messages: normalizeMessages(result.messages ?? []),
    };
  },
  run: (
    threadId: string,
    prompt: string,
    idempotencyKey: string,
    attachments?: Attachment[],
  ) =>
    request<Run>(baseUrl, "/api/runs", {
      method: "POST",
      body: JSON.stringify({ threadId, prompt, idempotencyKey, attachments }),
    }),
  runDetail: (id: string) =>
    request<Run>(baseUrl, `/api/runs/${encodeURIComponent(id)}`),
  events: (id: string) =>
    request<RunEvent[]>(baseUrl, `/api/runs/${encodeURIComponent(id)}/events`),
  cancel: (id: string) =>
    request<void>(baseUrl, `/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  approve: (id: string, approval: Approval, decision: "approve" | "deny") =>
    request<void>(baseUrl, `/api/runs/${encodeURIComponent(id)}/approval`, {
      method: "POST",
      body: JSON.stringify({
        requestId: approval.requestId ?? approval.id,
        decision,
      }),
    }),
  upload: async (file: { uri: string; name: string; mimeType?: string }) => {
    const form = new FormData();
    // Expo's fetch multipart encoder does not support React Native's `{ uri,
    // name, type }` descriptor. Its native encoder does support an object with
    // `bytes`, however, which keeps the file off the JS Blob/ArrayBuffer path
    // (React Native's BlobManager rejects ArrayBuffer parts).
    const nativeFile = new ExpoFile(file.uri);
    if (nativeFile.size > 10 * 1024 * 1024) throw new ApiError("Attachments must be 10 MiB or smaller.");
    const name = file.name || nativeFile.name || "attachment";
    const type = file.mimeType || "application/octet-stream";
    if (typeof (form as FormData & { getParts?: unknown }).getParts === "function") {
      const nativePart = {
        bytes: () => nativeFile.bytes(),
        name,
        type,
      };
      form.append("file", nativePart as unknown as Blob);
    } else {
      // Browsers and the unit-test FormData use standard Blob values.
      const blob = new Blob([await nativeFile.arrayBuffer()], { type });
      form.append("file", blob, name);
    }
    return request<{ attachment: Attachment }>(baseUrl, "/api/uploads", {
      method: "POST",
      body: form,
    });
  },
});

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError("Enter a valid workspace URL.");
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (parsed.username || parsed.password || parsed.hash || parsed.search)
    throw new ApiError(
      "Enter the workspace server URL without credentials or a pairing link.",
    );
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    throw new ApiError("Workspace connections must use HTTPS.");
  return trimmed;
}

export function normalizeMessages(input: unknown[]): Message[] {
  return input
    .map((item, index) => ({ message: normalizeMessage(item), index }))
    .filter(({ message }) => Boolean(message.content.trim() || message.error || message.attachments?.length || message.parts?.some((part) => part.type === "tool")))
    .sort((a, b) => {
      const at = messageTime(a.message);
      const bt = messageTime(b.message);
      if (at !== bt) return at - bt;
      const as = messageSequence(a.message);
      const bs = messageSequence(b.message);
      if (as !== bs) return as - bs;
      // Arbitrary IDs are not timestamps; preserve source order when time and
      // sequence cannot distinguish records.
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

const MAX_DISPLAY_TEXT = 16_000;

function displayText(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    // Tool results can contain image/file data URIs. Never copy those into a
    // React Native Text node (or retain the full value in message state).
    if (/^data:[^;,]+;base64,/i.test(value)) return "[binary data omitted]";
    if (value.length > 4096 && /^[A-Za-z0-9+/=\s]+$/.test(value)) return "[binary data omitted]";
    if (value.length > MAX_DISPLAY_TEXT) return `${value.slice(0, MAX_DISPLAY_TEXT)}…`;
    return value;
  }
  if (value == null || typeof value === "function" || typeof value === "symbol") return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (depth >= 4) return "[structured output omitted]";
  if (Array.isArray(value)) {
    return truncateDisplay(value.map((item) => displayText(item, depth + 1)).filter(Boolean).join("\n"));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return displayText(record.text, depth + 1);
    if (typeof record.message === "string") return displayText(record.message, depth + 1);
    const entries = Object.entries(record)
      .map(([key, item]) => {
        if (typeof item === "string" && item.length > 1024 && /(?:data|base64|bytes|encrypted|blob)/i.test(key)) {
          return `${key}: [binary data omitted]`;
        }
        const rendered = displayText(item, depth + 1);
        return rendered ? `${key}: ${rendered}` : "";
      })
      .filter(Boolean);
    return truncateDisplay(entries.join("\n"));
  }
  return "";
}

function truncateDisplay(value: string): string {
  return value.length > MAX_DISPLAY_TEXT ? `${value.slice(0, MAX_DISPLAY_TEXT)}…` : value;
}

function normalizeMessage(input: unknown): Message {
  const message = input && typeof input === "object" ? input as Message : {} as Message;
  const raw = (message as unknown as { content?: unknown }).content;
  const parts = Array.isArray(raw) ? raw : message.parts;
  const text = Array.isArray(parts)
    ? parts
        .filter((part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text",
          ),
        )
        .map((part) => displayText(part.text))
        .join("\n")
    : typeof raw === "string"
      ? displayText(raw)
      : "";
  const native = message as unknown as {
    type?: string;
    text?: string;
    files?: Message["attachments"];
  };
  const normalizedParts = Array.isArray(parts)
    ? parts.flatMap((part: unknown) => {
        if (!part || typeof part !== "object") return [];
        const value = part as Record<string, any>;
        if (value.type === "tool") {
          const output = typeof value.state?.output === "string"
            ? displayText(value.state.output)
            : value.state?.content !== undefined
              ? displayText(value.state.content)
              : displayText(value.output);
          const error = displayText(value.state?.error ?? value.error);
          const rawInput = value.state?.input ?? value.input;
          const input = rawInput && typeof rawInput === "object"
            ? Object.fromEntries(["url", "path", "command"].flatMap((key) =>
                typeof rawInput[key] === "string" ? [[key, displayText(rawInput[key])]] : [],
              ))
            : undefined;
          const rawStatus = value.state?.status ?? value.status ?? "running";
          return [{
            type: "tool" as const,
            id: value.id ?? value.callID,
            name: typeof value.name === "string" ? value.name : "tool",
            status: ["error", "failed", "cancelled"].includes(rawStatus) ? "failed" : rawStatus,
            ...(input && Object.keys(input).length ? { input } : {}),
            ...(output ? { output } : {}),
            ...(error ? { error } : {}),
          } as NonNullable<Message["parts"]>[number]];
        }
        if (value.type === "text") return [{ type: "text" as const, text: displayText(value.text) }];
        return [];
      })
    : message.parts;
  const created = (message as Message & { time?: { created?: unknown } }).time?.created;
  const createdAt = message.createdAt ?? toIso(created);
  return {
    ...message,
    role: message.role ?? native.type ?? "assistant",
    content: text || displayText(native.text),
    parts: normalizedParts,
    attachments: message.attachments ?? native.files,
    ...(message.error ? { error: displayText(message.error) } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function toMillis(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}
function toIso(value: unknown): string | undefined {
  const millis = toMillis(value);
  return millis === Number.MAX_SAFE_INTEGER ? undefined : new Date(millis).toISOString();
}
function messageTime(message: Message): number { return toMillis(message.createdAt); }
function messageSequence(message: Message): number {
  const sequence = (message as Message & { sequence?: unknown }).sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : Number.MAX_SAFE_INTEGER;
}
