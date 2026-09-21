import { consumeConnectionFragment } from "./lib/bootstrap-connection";
import { normalizeNativeMessages } from "./lib/transcript";
export type Bot = {
  id: string;
  name: string;
  instructions?: string;
  model?: string;
  agent?: string;
  nodeId?: string;
  status?: string;
  createdAt?: string;
};
export type Thread = {
  id: string;
  botId?: string;
  nodeId?: string;
  title: string;
  runnerSessionId?: string;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type ToolPart = {
  type: "tool";
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  input?: unknown;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};
export type MessagePart = { type: "text"; text: string } | ToolPart;
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
export type Message = {
  id?: string;
  role: "user" | "assistant" | "system" | string;
  content: string;
  parts?: MessagePart[];
  createdAt?: string;
  status?: string;
  error?: string;
  attachments?: Attachment[];
};
export type RunEvent = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  createdAt?: string;
  data?: unknown;
  payload?: any;
};
export type ApprovalRequest = {
  id?: string;
  requestId?: string;
  action?: string;
  description?: string;
  command?: string;
  target?: string;
  scope?: string;
  expiresAt?: string;
  status?: string;
  details?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};
export type Run = {
  internal?: boolean;
  startedAt?: string;
  queue?: {
    position: number;
    blockedBy?: { id: string; status: string; botName: string };
    reconnecting?: boolean;
  };
  id: string;
  threadId: string;
  status: string;
  prompt?: string;
  events?: RunEvent[];
  result?: string;
  error?: string;
  attachments?: Attachment[];
  createdAt?: string;
  updatedAt?: string;
  approval?: ApprovalRequest;
  approvalRequest?: ApprovalRequest;
  pendingApproval?: ApprovalRequest;
  approvals?: ApprovalRequest[];
};
export type MemoryItem = {
  id: string;
  content: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type Routine = {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt?: string;
  updatedAt?: string;
};
export type ComputerStatus = {
  readiness?: string;
  state?: string;
  id?: string;
  status?: string;
  phase?: string;
  activeRunId?: string;
  checkpoint?: {
    id?: string;
    createdAt?: string;
    sizeBytes?: number;
    bytes?: number;
    manifest?: string;
  };
  lastCheckpoint?: {
    id?: string;
    createdAt?: string;
    sizeBytes?: number;
    bytes?: number;
    manifest?: string;
  };
  durable?: boolean;
  computerId?: string;
};
export type ComputerReadiness = {
  state: "starting" | "ready" | "error" | string;
  startedAt?: string;
  error?: string;
  retryAfterMs?: number;
};
export type UpdateJob = {
  id?: string;
  phase?: string;
  requestedVersion?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
};
export type UpdateStatus = {
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  configured: boolean;
  configuration?: { accountId?: string; workerName?: string };
  job?: UpdateJob;
  releaseUrl?: string;
  checkError?: string;
};
export type StorageObject = {
  key: string;
  size: number;
  uploaded: string;
  category: "checkpoint" | "artifact" | "other";
  protected: boolean;
};
export type StoragePolicy = {
  automatic: boolean;
  intervalMinutes: number;
  keepLatest: number;
  budgetBytes: number;
};
export type StorageSummary = {
  objects: StorageObject[];
  totals: { bytes: number; checkpointBytes: number; otherBytes: number; objects: number };
  truncated: boolean;
  policy: StoragePolicy;
  lastAutomaticCheckpointAt?: string;
  lastError?: string;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdAt?: string;
  updatedAt?: string;
};
export type FileArtifact = {
  path: string;
  kind?: string;
  size?: number;
  modifiedAt: string;
  [key: string]: unknown;
};
export type CatalogModel = {
  id?: string;
  name?: string;
  providerID?: string;
  provider?: string;
  cost?: unknown;
  pricing?: unknown;
  [key: string]: unknown;
};
export type CatalogAgent = {
  id?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
};
export type CatalogCommand = {
  name: string;
  description?: string;
  execution?: "native-session-command" | string;
  [key: string]: unknown;
};
export type CatalogAction = {
  name: string;
  execution?: "native-action" | string;
  action?: string;
  requires?: string[];
  [key: string]: unknown;
};
export type Catalog = {
  runtime?: { name?: string; version?: string };
  location?: string;
  models?: CatalogModel[];
  providers?: unknown[];
  agents?: CatalogAgent[];
  commands?: CatalogCommand[];
  clientOnlyCommands?: string[];
  cliOnlyCommands?: string[];
  actions?: CatalogAction[];
  mcp?: unknown[];
};
export type McpServerStatus =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth"; error: string };
export type McpServer = {
  name: string;
  status: McpServerStatus;
  integrationID?: string;
};
export type McpAuthMethod = { id: string; type?: string; label?: string; form?: Record<string, unknown> };
export type McpServerList = { location?: string; servers: McpServer[]; integrations?: Array<{ id: string; methods?: McpAuthMethod[] }> };
export type State = {
  pendingMessages?: Array<{
    id: string;
    threadId: string;
    runId: string;
    content: string;
    status: string;
    nativeId?: string;
    createdAt: string;
    attachments?: Attachment[];
  }>;
  bots: Bot[];
  threads: Thread[];
  runs: Run[];
  messages?: Record<string, Message[]>;
  threadMessages?: Record<string, Message[]>;
};

const base =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  "";
const tokenKey = "opencode-bot-app-token";
if (typeof window !== "undefined") {
  consumeConnectionFragment(
    window.location,
    window.history,
    window.localStorage,
  );
}
export const CONNECTION_EVENT = "opencode-bot-connection-change";
/** True when the shared Computer is still coming online. */
export const isComputerWarmingUpError = (error: unknown) => {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code) return code === "computer_starting";
  return (
    (status === undefined || status === 503) &&
    /computer (?:is )?(?:starting|warming up)|warming up in the background/i.test(
      message,
    )
  );
};
// Connection credentials belong to this installation, not one browser tab.
// Migrate existing tabs once and share subsequent changes across the origin.
export const getToken = () => {
  const saved = localStorage.getItem(tokenKey);
  if (saved !== null) return saved;
  const legacy = sessionStorage.getItem(tokenKey)?.trim() ?? "";
  if (legacy) {
    localStorage.setItem(tokenKey, legacy);
    sessionStorage.removeItem(tokenKey);
  }
  return legacy;
};
export const setToken = (value: string) => {
  const token = value.trim();
  if (token) localStorage.setItem(tokenKey, token);
  else localStorage.removeItem(tokenKey);
  sessionStorage.removeItem(tokenKey);
  window.dispatchEvent(new Event(CONNECTION_EVENT));
};

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    signal:
      init.signal ??
      AbortSignal.timeout(path.includes("/computer/") ? 120_000 : 30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      if (token?.startsWith("dt_")) {
        setToken("");
        const error = new Error(
          "This device connection expired or was revoked. Pair it again.",
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      if (getToken() && getToken() !== token) return request<T>(path, init);
      const error = new Error(
        "Connection needs attention. Update the application token in Settings.",
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    let message =
      response.status >= 500
        ? `The workspace server is reconnecting (${response.status}). Please try again shortly.`
        : body.slice(0, 500);
    try {
      const parsed = JSON.parse(body) as {
        error?: string;
        message?: string;
        title?: string;
      };
      const detail = parsed.error ?? parsed.message ?? parsed.title;
      if (typeof detail === "string" && detail.length <= 500) message = detail;
    } catch {
      /* plain text response */
    }
    const error = new Error(
      message || `${response.status} ${response.statusText}`,
    ) as Error & { status?: number; code?: string };
    error.status = response.status;
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === "string") error.code = parsed.code;
    } catch {
      /* plain text response */
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function requestBlob(
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const headers = new Headers({ Accept: "*/*" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, {
    headers,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Could not download attachment (${response.status})`);
  return response.blob();
}
export async function requestText(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const headers = new Headers({ Accept: "text/plain" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, {
    headers,
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read file (${response.status})`);
  return response.text();
}

// Readiness and the settings surfaces can ask for the catalog at the same
// time (for example when a warming computer becomes ready). Share the active
// request so one readiness transition produces one native catalog fetch.
let catalogInFlight: Promise<Catalog> | undefined;
const catalog = () => {
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = request<Catalog>("/api/catalog").finally(() => {
    catalogInFlight = undefined;
  });
  return catalogInFlight;
};

export const api = {
  state: () => request<State>("/api/state"),
  bot: (payload: {
    name: string;
    instructions: string;
    model: string;
    agent?: string;
    nodeId?: string;
  }) =>
    request<Bot>("/api/bots", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateBot: (
    id: string,
    payload: {
      name?: string;
      instructions?: string;
      model?: string;
      agent?: string;
      nodeId?: string;
    },
  ) =>
    request<Bot>(`/api/bots/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  thread: (payload: { botId: string; title: string }) =>
    request<Thread>("/api/threads", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  renameThread: (id: string, title: string) =>
    request<Thread>(`/api/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteThread: (id: string) =>
    request<void>(`/api/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  deleteBot: (id: string) =>
    request<void>(`/api/bots/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  threadMessages: async (threadId: string) => {
    const result = await request<{ sessionId?: string; messages: any[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
    );
    return {
      sessionId: result.sessionId,
      messages: normalizeNativeMessages(result.messages),
    };
  },
  upload: async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    const result = await request<{ attachment: Attachment }>("/api/uploads", {
      method: "POST",
      body,
    });
    return result.attachment;
  },
  download: (id: string, signal?: AbortSignal) =>
    requestBlob(`/api/uploads/${encodeURIComponent(id)}`, signal),
  run: (payload: {
    threadId: string;
    prompt: string;
    idempotencyKey: string;
    commandName?: string;
    commandText?: string;
    attachments?: Attachment[];
  }) =>
    request<Run>("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  threadAction: (
    threadId: string,
    payload: {
      command?: string;
      text?: string;
      messageID?: string;
      files?: boolean;
      sessionAction?: { name: string; input?: Record<string, unknown> };
      idempotencyKey: string;
    },
  ) =>
    request<Run>(`/api/threads/${encodeURIComponent(threadId)}/action`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  runDetail: (id: string) =>
    request<Run>(`/api/runs/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    request<void>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  approval: (id: string, payload: { requestId: string; decision: string }) =>
    request<void>(`/api/runs/${encodeURIComponent(id)}/approval`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  memories: (botId: string) =>
    request<MemoryItem[]>(`/api/bots/${encodeURIComponent(botId)}/memory`),
  addMemory: (botId: string, content: string) =>
    request<MemoryItem>(`/api/bots/${encodeURIComponent(botId)}/memory`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (botId: string, memoryId: string) =>
    request<void>(
      `/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
    ),
  routines: () => request<Routine[]>("/api/routines"),
  createRoutine: (payload: {
    botId: string;
    title: string;
    prompt: string;
    intervalMinutes: number;
    enabled: boolean;
  }) =>
    request<Routine>("/api/routines", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateRoutine: (id: string, payload: { enabled: boolean }) =>
    request<Routine>(`/api/routines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteRoutine: (id: string) =>
    request<void>(`/api/routines/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  computerStatus: () => request<ComputerStatus>("/api/computer/status"),
  computerReadiness: () =>
    request<ComputerReadiness>("/api/computer/readiness"),
  updates: () => request<UpdateStatus>("/api/updates"),
  configureUpdates: (payload: {
    accountId: string;
    workerName: string;
    token: string;
  }) =>
    request<UpdateStatus>("/api/updates/configure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  removeUpdatesConfiguration: () =>
    request<void>("/api/updates/configure", { method: "DELETE" }),
  startUpdate: (version: string) =>
    request<UpdateStatus>("/api/updates", {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  recoverUpdate: () =>
    request<UpdateStatus>("/api/updates/recover", { method: "POST" }),
  checkpoint: () =>
    request<ComputerStatus>("/api/computer/checkpoint", { method: "POST" }),
  restoreCheckpoint: (checkpointId?: string) =>
    request<ComputerStatus>("/api/computer/restore", {
      method: "POST",
      body: JSON.stringify(checkpointId ? { checkpointId } : {}),
    }),
  skills: () => request<Skill[]>("/api/skills"),
  createSkill: (payload: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<Skill>("/api/skills", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateSkill: (
    id: string,
    payload: { name: string; description: string; instructions: string },
  ) =>
    request<Skill>(`/api/skills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteSkill: (id: string) =>
    request<void>(`/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  botSkills: (botId: string) =>
    request<Skill[]>(`/api/bots/${encodeURIComponent(botId)}/skills`),
  assignSkills: (botId: string, skillIds: string[]) =>
    request<Skill[]>(`/api/bots/${encodeURIComponent(botId)}/skills`, {
      method: "PUT",
      body: JSON.stringify({ skillIds }),
    }),
  files: (path = ".", signal?: AbortSignal) =>
    request<{ artifacts?: FileArtifact[] } | FileArtifact[]>(
      `/api/files?path=${encodeURIComponent(path)}`,
      { signal },
    ),
  fileContent: (path: string, signal?: AbortSignal) =>
    requestText(`/api/files/content?path=${encodeURIComponent(path)}`, signal),
  fileDownload: (path: string, signal?: AbortSignal) =>
    requestBlob(`/api/files/content?path=${encodeURIComponent(path)}`, signal),
  fileUpload: (path: string, body: ArrayBuffer, mimeType?: string) =>
    request<{ path: string; bytes: number }>(
      `/api/files?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { "content-type": mimeType || "application/octet-stream" },
        body,
      },
    ),
  fileMkdir: (path: string) =>
    request<{ path: string; kind: "directory" }>(
      `/api/files/mkdir?path=${encodeURIComponent(path)}`,
      { method: "POST" },
    ),
  fileMove: (from: string, to: string) =>
    request<{ from: string; to: string }>(
      `/api/files/move?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { method: "POST" },
    ),
  fileDelete: (path: string) =>
    request<{ deleted: boolean }>(
      `/api/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  catalog,
  storage: {
    get: () => request<StorageSummary>("/api/storage"),
    updatePolicy: (policy: StoragePolicy) => request<StorageSummary>("/api/storage/policy", { method: "POST", body: JSON.stringify(policy) }),
    cleanup: (keys: string[]) => request<StorageSummary>("/api/storage/cleanup", { method: "POST", body: JSON.stringify({ keys }) }),
  },
  mcp: {
    list: () => request<McpServerList>("/api/mcps"),
    resources: () => request<{ location?: string; resources: unknown[]; templates: unknown[] }>("/api/mcps/resources"),
    connect: (server: string) =>
      request<{ ok: boolean; server: string }>("/api/mcps/connect", { method: "POST", body: JSON.stringify({ server }) }),
    disconnect: (server: string) =>
      request<{ ok: boolean; server: string }>("/api/mcps/disconnect", { method: "POST", body: JSON.stringify({ server }) }),
    authStart: (payload: { integrationID: string; methodID: string; answer?: Record<string, unknown> }) =>
      request<{ attempt?: { attemptID?: string; url?: string; instructions?: string; mode?: string } }>("/api/mcps/oauth/start", { method: "POST", body: JSON.stringify(payload) }),
    authStatus: (payload: { integrationID: string; attemptID: string }) =>
      request<Record<string, unknown>>("/api/mcps/oauth/status", { method: "POST", body: JSON.stringify(payload) }),
    authComplete: (payload: { integrationID: string; attemptID: string; code?: string }) =>
      request<{ ok: boolean }>("/api/mcps/oauth/complete", { method: "POST", body: JSON.stringify(payload) }),
    authCancel: (payload: { integrationID: string; attemptID: string }) =>
      request<{ ok: boolean }>("/api/mcps/oauth/cancel", { method: "POST", body: JSON.stringify(payload) }),
  },
  preview: async (signal?: AbortSignal) => {
    const token = getToken();
    const headers = new Headers({
      Accept: "multipart/x-mixed-replace,image/jpeg",
    });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${base}/api/computer/preview`, {
      headers,
      signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      let message = `Preview unavailable (${response.status})`;
      try {
        message = JSON.parse(detail).error ?? message;
      } catch {
        /* non-JSON upstream error */
      }
      throw new Error(
        response.status === 401
          ? "Connection needs attention. Update the application token in Settings."
          : message,
      );
    }
    return response;
  },
};
