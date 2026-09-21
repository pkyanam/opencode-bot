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
export type Message = {
  id?: string;
  role: "user" | "assistant" | "system" | string;
  content: string;
  parts?: MessagePart[];
  createdAt?: string;
  status?: string;
  error?: string;
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
  queue?: { position: number; blockedBy?: { id: string; status: string; botName: string }; reconnecting?: boolean };
  id: string;
  threadId: string;
  status: string;
  prompt?: string;
  events?: RunEvent[];
  result?: string;
  error?: string;
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
  modifiedAt?: string;
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
export type State = {
  pendingMessages?: Array<{id:string;threadId:string;runId:string;content:string;status:string;nativeId?:string;createdAt:string}>;
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
  consumeConnectionFragment(window.location, window.history, window.localStorage);
}
export const CONNECTION_EVENT = "opencode-bot-connection-change";
/** True when the shared Computer is still coming online. */
export const isComputerWarmingUpError = (error: unknown) => {
  const status = error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code) return code === "computer_starting";
  return (status === undefined || status === 503) && /computer (?:is )?(?:starting|warming up)|warming up in the background/i.test(message);
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
  if (init.body) headers.set("Content-Type", "application/json");
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
      if (getToken() && getToken() !== token) return request<T>(path, init);
      const error = new Error(
        "Connection needs attention. Update the application token in Settings.",
      ) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? body;
    } catch {
      /* plain text response */
    }
    const error = new Error(message || `${response.status} ${response.statusText}`) as Error & { status?: number; code?: string };
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
  run: (payload: {
    threadId: string;
    prompt: string;
    idempotencyKey: string;
    commandName?: string;
    commandText?: string;
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
  computerReadiness: () => request<ComputerReadiness>("/api/computer/readiness"),
  updates: () => request<UpdateStatus>("/api/updates"),
  configureUpdates: (payload: { accountId: string; workerName: string; token: string }) =>
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
  recoverUpdate: () => request<UpdateStatus>("/api/updates/recover", { method: "POST" }),
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
  files: (path = ".") =>
    request<{ artifacts?: FileArtifact[] } | FileArtifact[]>(
      `/api/files?path=${encodeURIComponent(path)}`,
    ),
  catalog: () => request<Catalog>("/api/catalog"),
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
