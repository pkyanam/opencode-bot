import { clearConnection, readToken } from "./storage";
import type {
  Approval,
  Attachment,
  Message,
  Run,
  RunEvent,
  State,
  Thread,
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
  return () => { authInvalidated.delete(listener); };
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
  const { auth: includeAuth = true, timeoutMs = 30_000, ...fetchInit } = init;
  const url = normalizeBaseUrl(baseUrl);
  const authToken = await token();
  const headers = new Headers(fetchInit.headers);
  headers.set("Accept", "application/json");
  if (fetchInit.body && !(fetchInit.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (includeAuth && authToken) headers.set("Authorization", `Bearer ${authToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = fetchInit.signal;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, { ...fetchInit, headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new ApiError("The workspace request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    const raw = await response.text();
    let message = raw || `${response.status} ${response.statusText}`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        error?: string;
        message?: string;
        code?: string;
      };
      message = parsed.error ?? parsed.message ?? message;
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
  return response.json() as Promise<T>;
}

type MobileRequestInit = RequestInit & { auth?: boolean; timeoutMs?: number };
export const api = (baseUrl: string) => ({
  state: () => request<State>(baseUrl, "/api/state"),
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
  messages: async (threadId: string) => {
    const result = await request<{ messages: Message[] }>(
      baseUrl,
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
    );
    return {
      ...result,
      messages: (result.messages ?? []).map(normalizeMessage),
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
    form.append("file", {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? "application/octet-stream",
    } as unknown as Blob);
    return request<{ attachment: Attachment }>(baseUrl, "/api/uploads", {
      method: "POST",
      body: form,
    });
  },
});

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new ApiError("Enter a valid workspace URL."); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new ApiError("Enter the workspace server URL without credentials or a pairing link.");
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    throw new ApiError("Workspace connections must use HTTPS.");
  return trimmed;
}

function normalizeMessage(message: Message): Message {
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
        .map((part) => String(part.text ?? ""))
        .join("\n")
    : typeof raw === "string"
      ? raw
      : "";
  const native = message as unknown as { type?: string; text?: string; files?: Message["attachments"] };
  const normalizedParts = Array.isArray(parts) ? parts.map((part: any) => part.type === "tool" ? {
    ...part,
    id: part.id ?? part.callID,
    status: part.state?.status ?? part.status ?? "running",
    output: typeof part.state?.output === "string" ? part.state.output : typeof part.state?.content === "string" ? part.state.content : part.output,
    error: part.state?.error ?? part.error,
  } : part) : message.parts;
  return {
    ...message,
    role: message.role ?? native.type ?? "assistant",
    content: text || native.text || "",
    parts: normalizedParts,
    attachments: message.attachments ?? native.files,
  };
}
