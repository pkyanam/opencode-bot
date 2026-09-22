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
  state: "starting" | "ready" | "sleeping" | "error" | string;
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
      AbortSignal.timeout(
        /\/api\/computer\/(?:sleep|wake|checkpoint|restore)/.test(path)
          ? 300_000
          : path.includes("/computer/")
            ? 120_000
            : 30_000,
      ),
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
const catalogInFlight = new Map<string, Promise<Catalog>>();
const catalog = (nodeId?: string) => {
  const key = nodeId ?? "cloudflare";
  const active = catalogInFlight.get(key);
  if (active) return active;
  const next = (nodeId ? nodeRuntime<Catalog>(nodeId, "catalog") : request<Catalog>("/api/catalog")).finally(() => {
    catalogInFlight.delete(key);
  });
  catalogInFlight.set(key, next);
  return next;
};

async function nodeRuntime<T = unknown>(nodeId: string, operation: string, method = "GET", input?: unknown): Promise<T> {
  const base = `/api/nodes/${encodeURIComponent(nodeId)}/runtime/${encodeURIComponent(operation)}`;
  const receipt = await request<{ jobId: string }>(base, {
    method: "POST",
    body: JSON.stringify(input && typeof input === "object" ? input : {}),
  });
  return waitNodeJob<T>(nodeId, receipt.jobId, operation);
}

async function waitNodeJob<T>(nodeId: string, jobId: string, operation = "file operation"): Promise<T> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const job = await request<{ status: string; result?: T; error?: string }>(`/api/nodes/${encodeURIComponent(nodeId)}/runtime/jobs/${encodeURIComponent(jobId)}`);
    if (job.status === "succeeded") return job.result as T;
    if (["failed", "needs_review"].includes(job.status)) throw new Error(job.error || `Node runtime operation ${operation} failed.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Node runtime operation ${operation} timed out.`);
}

async function relayFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) throw new Error((await response.text().catch(() => "")) || `File relay failed (${response.status})`);
  return response;
}

async function nodeFileDownload(path: string, nodeId: string) {
  const stat = await nodeRuntime<{ size: number; name?: string; sha256: string }>(nodeId, "file_stat", "POST", { scope: "computer", path });
  const relay = await request<{ relayId: string; relayToken: string; jobId: string }>("/api/node-files", { method: "POST", body: JSON.stringify({ nodeId, direction: "export", path, size: stat.size, sha256: stat.sha256, name: stat.name ?? path.split(/[\\/]/).pop() ?? "download" }) });
  await waitNodeJob(nodeId, relay.jobId, "file export");
  const blob = await (await relayFetch(`/api/node-files/${encodeURIComponent(relay.relayId)}/content`, { headers: { Authorization: `Bearer ${relay.relayToken}` } })).blob();
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== stat.sha256) throw new Error("Computer file changed while it was being downloaded. Try again.");
  return blob;
}

async function nodeFileUpload(path: string, body: ArrayBuffer, mimeType: string | undefined, nodeId: string, overwrite: boolean) {
  if (body.byteLength > 50 * 1024 * 1024) throw new Error("Computer files must be 50 MiB or smaller.");
  const digest = await crypto.subtle.digest("SHA-256", body);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const relay = await request<{ relayId: string; relayToken: string; jobId?: string }>("/api/node-files", { method: "POST", body: JSON.stringify({ nodeId, direction: "import", path, size: body.byteLength, sha256, name: path.split(/[\\/]/).pop() ?? "upload", overwrite }) });
  const uploaded = await relayFetch(`/api/node-files/${encodeURIComponent(relay.relayId)}/content`, { method: "PUT", headers: { Authorization: `Bearer ${relay.relayToken}`, "Content-Type": mimeType || "application/octet-stream" }, body });
  const uploadReceipt = await uploaded.json().catch(() => ({})) as { jobId?: string };
  if (uploadReceipt.jobId || relay.jobId) await waitNodeJob(nodeId, uploadReceipt.jobId ?? relay.jobId!, "file import");
  return { path, bytes: body.byteLength };
}

async function ownedWorkspacePath(nodeId: string, value: string) {
  const roots = await nodeRuntime<{ workspace?: string; root?: string }>(nodeId, "file_roots", "POST", {});
  const root = roots.workspace ?? roots.root;
  if (!root) throw new Error("The selected computer did not provide a workspace root.");
  const relative = value === "." ? "" : value.replace(/^\.\//, "").replace(/^[/\\]+/, "");
  if (relative.split(/[\\/]/).some((part) => part === "..")) throw new Error("Workspace paths cannot leave the selected workspace.");
  return relative ? `${root.replace(/[\\/]$/, "")}/${relative}` : root;
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
  sleepComputer: () => request<ComputerStatus>("/api/computer/sleep", { method: "POST" }),
  wakeComputer: () => request<ComputerStatus>("/api/computer/wake", { method: "POST" }),
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
  files: (path = ".", signal?: AbortSignal, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (async () => {
          const absolute = options.scope === "workspace" ? await ownedWorkspacePath(options.nodeId!, path) : path;
          const result = await nodeRuntime<{ artifacts?: FileArtifact[] } | FileArtifact[]>(options.nodeId!, "file_list", "POST", { scope: "computer", path: absolute, limit: 500 });
          if (options.scope !== "workspace") return result;
          const relativeFolder = path === "." ? "" : path.replaceAll("\\", "/").replace(/\/$/, "") + "/";
          const parent = absolute.replaceAll("\\", "/").replace(/\/$/, "") + "/";
          const map = (item: FileArtifact) => ({ ...item, path: relativeFolder + item.path.replaceAll("\\", "/").slice(parent.length) });
          return Array.isArray(result) ? result.map(map) : { ...result, artifacts: (result.artifacts ?? []).map(map) };
        })()
      : request<{ artifacts?: FileArtifact[] } | FileArtifact[]>(
      `/api/files?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`,
      { signal },
    ),
  fileContent: (path: string, signal?: AbortSignal, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, path) : Promise.resolve(path)).then((absolute) => nodeRuntime<{ contentBase64?: string }>(options.nodeId!, "file_read", "POST", { scope: "computer", path: absolute })).then((result) => result.contentBase64 ? new TextDecoder().decode(Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0))) : "")
      : requestText(`/api/files/content?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`, signal),
  fileDownload: (path: string, signal?: AbortSignal, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, path) : Promise.resolve(path)).then((absolute) => nodeFileDownload(absolute, options.nodeId!))
      : requestBlob(`/api/files/content?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`, signal),
  fileUpload: (path: string, body: ArrayBuffer, mimeType?: string, options: { scope?: "workspace" | "computer"; nodeId?: string; overwrite?: boolean } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, path) : Promise.resolve(path)).then((absolute) => nodeFileUpload(absolute, body, mimeType, options.nodeId!, options.overwrite === true))
      : request<{ path: string; bytes: number }>(
      `/api/files?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}${options.overwrite ? "&overwrite=true" : ""}`,
      {
        method: "POST",
        headers: { "content-type": mimeType || "application/octet-stream" },
        body,
      },
    ),
  fileMkdir: (path: string, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, path) : Promise.resolve(path)).then((absolute) => nodeRuntime<{ path: string; kind: "directory" }>(options.nodeId!, "file_mkdir", "POST", { scope: "computer", path: absolute }))
      : request<{ path: string; kind: "directory" }>(
      `/api/files/mkdir?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`,
      { method: "POST" },
    ),
  fileMove: (from: string, to: string, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? Promise.all([options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, from) : Promise.resolve(from), options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, to) : Promise.resolve(to)]).then(([source, destination]) => nodeRuntime<{ from: string; to: string }>(options.nodeId!, "file_move", "POST", { scope: "computer", from: source, to: destination }))
      : request<{ from: string; to: string }>(
      `/api/files/move?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`,
      { method: "POST" },
    ),
  fileDelete: (path: string, options: { scope?: "workspace" | "computer"; nodeId?: string } = {}) =>
    options.nodeId && (options.scope === "computer" || options.scope === "workspace")
      ? (options.scope === "workspace" ? ownedWorkspacePath(options.nodeId, path) : Promise.resolve(path)).then((absolute) => nodeRuntime<{ deleted: boolean }>(options.nodeId!, "file_delete", "POST", { scope: "computer", path: absolute }))
      : request<{ deleted: boolean }>(
      `/api/files?path=${encodeURIComponent(path)}${options.scope ? `&scope=${options.scope}` : ""}${options.nodeId ? `&nodeId=${encodeURIComponent(options.nodeId)}` : ""}`,
      { method: "DELETE" },
    ),
  catalog,
  nodeRuntime,
  storage: {
    get: () => request<StorageSummary>("/api/storage"),
    updatePolicy: (policy: StoragePolicy) => request<StorageSummary>("/api/storage/policy", { method: "POST", body: JSON.stringify(policy) }),
    cleanup: (keys: string[]) => request<StorageSummary>("/api/storage/cleanup", { method: "POST", body: JSON.stringify({ keys }) }),
  },
  mcp: {
    list: (nodeId?: string) => nodeId ? nodeRuntime<McpServerList>(nodeId, "mcps") : request<McpServerList>("/api/mcps"),
    resources: () => request<{ location?: string; resources: unknown[]; templates: unknown[] }>("/api/mcps/resources"),
    connect: (server: string, nodeId?: string) =>
      nodeId ? nodeRuntime<{ ok: boolean; server: string }>(nodeId, "mcps/connect", "POST", { server }) : request<{ ok: boolean; server: string }>("/api/mcps/connect", { method: "POST", body: JSON.stringify({ server }) }),
    disconnect: (server: string, nodeId?: string) =>
      nodeId ? nodeRuntime<{ ok: boolean; server: string }>(nodeId, "mcps/disconnect", "POST", { server }) : request<{ ok: boolean; server: string }>("/api/mcps/disconnect", { method: "POST", body: JSON.stringify({ server }) }),
    authStart: (payload: { integrationID: string; methodID: string; answer?: Record<string, unknown>; nodeId?: string }) =>
      payload.nodeId ? nodeRuntime<{ attempt?: { attemptID?: string; url?: string; instructions?: string; mode?: string } }>(payload.nodeId, "mcps/oauth/start", "POST", payload) : request<{ attempt?: { attemptID?: string; url?: string; instructions?: string; mode?: string } }>("/api/mcps/oauth/start", { method: "POST", body: JSON.stringify(payload) }),
    authStatus: (payload: { integrationID: string; attemptID: string; nodeId?: string }) =>
      payload.nodeId ? nodeRuntime<Record<string, unknown>>(payload.nodeId, "mcps/oauth/status", "POST", payload) : request<Record<string, unknown>>("/api/mcps/oauth/status", { method: "POST", body: JSON.stringify(payload) }),
    authComplete: (payload: { integrationID: string; attemptID: string; code?: string; callbackUrl?: string; nodeId?: string }) =>
      payload.nodeId ? nodeRuntime<{ ok: boolean; pending?: boolean }>(payload.nodeId, "mcps/oauth/complete", "POST", payload) : request<{ ok: boolean; pending?: boolean }>("/api/mcps/oauth/complete", { method: "POST", body: JSON.stringify(payload) }),
    authCancel: (payload: { integrationID: string; attemptID: string; nodeId?: string }) =>
      payload.nodeId ? nodeRuntime<{ ok: boolean }>(payload.nodeId, "mcps/oauth/cancel", "POST", payload) : request<{ ok: boolean }>("/api/mcps/oauth/cancel", { method: "POST", body: JSON.stringify(payload) }),
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
