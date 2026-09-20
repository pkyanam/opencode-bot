export type RunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "waiting_approval"
  | "waiting_human"
  | "waiting_dependency"
  | "checkpointing"
  | "succeeded"
  | "recovering"
  | "needs_review"
  | "failed"
  | "cancelling"
  | "cancelled";

export type Decision = "approve" | "deny";

export type Bot = {
  id: string;
  name: string;
  instructions: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type Thread = {
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Run = {
  id: string;
  threadId: string;
  prompt: string;
  status: RunStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: string;
};

export type Event = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued", "provisioning", "running", "waiting_approval", "waiting_human",
  "waiting_dependency", "checkpointing", "recovering", "cancelling",
]);

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded", "failed", "needs_review", "cancelled",
]);

const transitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["provisioning", "waiting_dependency", "cancelling", "failed", "cancelled"]),
  provisioning: new Set(["running", "waiting_dependency", "recovering", "cancelling", "failed"]),
  running: new Set(["waiting_approval", "waiting_human", "waiting_dependency", "checkpointing", "recovering", "cancelling", "succeeded", "failed", "needs_review"]),
  waiting_approval: new Set(["running", "cancelling", "cancelled", "succeeded", "failed", "needs_review"]),
  waiting_human: new Set(["running", "cancelling", "failed", "needs_review"]),
  waiting_dependency: new Set(["queued", "provisioning", "cancelling", "failed", "cancelled"]),
  checkpointing: new Set(["succeeded", "recovering", "failed", "cancelling"]),
  recovering: new Set(["provisioning", "running", "needs_review", "failed", "cancelling"]),
  cancelling: new Set(["cancelled", "failed"]),
  succeeded: new Set(), failed: new Set(), needs_review: new Set(), cancelled: new Set(),
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new Error(`invalid run transition: ${from} -> ${to}`);
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function isoNow(): string { return new Date().toISOString(); }

export function json(value: unknown): string { return JSON.stringify(value ?? null); }

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
