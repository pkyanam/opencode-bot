export type Bot = {
  id: string;
  name: string;
  instructions?: string;
  model?: string;
  agent?: string;
  status?: string;
  createdAt?: string;
};
export type Thread = {
  id: string;
  botId?: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
};
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
export type ToolPart = {
  type: "tool";
  id: string;
  name: string;
  status: string;
  output?: string;
  error?: string;
};
export type Message = {
  id?: string;
  role: string;
  content: string;
  parts?: Array<{ type: "text"; text: string } | ToolPart>;
  attachments?: Attachment[];
  createdAt?: string;
  error?: string;
};
export type Run = {
  id: string;
  threadId: string;
  status: string;
  startedAt?: string;
  events?: RunEvent[];
  result?: string;
  error?: string;
  pendingApproval?: Approval;
  approval?: Approval;
  approvalRequest?: Approval;
};
export type RunEvent = {
  id?: string;
  type?: string;
  message?: string;
  content?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
  data?: unknown;
};
export type Approval = {
  requestId?: string;
  id?: string;
  action?: string;
  description?: string;
  command?: string;
  target?: string;
  expiresAt?: string;
};
export type State = {
  bots: Bot[];
  threads: Thread[];
  runs: Run[];
  messages?: Record<string, Message[]>;
  threadMessages?: Record<string, Message[]>;
};
export type CatalogModel = { id?: string; name?: string; providerID?: string; provider?: string; [key: string]: unknown };
export type CatalogAgent = { id?: string; name?: string; description?: string; [key: string]: unknown };
export type Catalog = { runtime?: { name?: string; version?: string }; models?: CatalogModel[]; agents?: CatalogAgent[]; commands?: Array<{ name: string; description?: string }>; actions?: Array<{ name: string; action?: string }>; };
export type Skill = { id: string; name: string; description: string; instructions: string; createdAt?: string; updatedAt?: string };
export type FileArtifact = { path: string; kind?: string; size?: number; modifiedAt?: string; [key: string]: unknown };
export type MemoryVisibility = "private" | "shared" | "workspace";
export type MemoryItem = {
  id: string;
  botId: string | null;
  title?: string;
  content: string;
  kind?: string;
  tags: string[];
  visibility: MemoryVisibility;
  sharedBotIds: string[];
  pinned: boolean;
  revision: number;
  sourceThreadId?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type HindsightEngineStatus = {
  provider: "hindsight";
  configured: boolean;
  enabled: boolean;
  status: "ready" | "starting" | "unavailable" | "disabled";
  error?: string;
  pending: number;
  failed: number;
  settings: { url?: string; model?: string; autoCapture: boolean };
  capabilities: Array<"retain" | "recall" | "reflect" | "observations" | "mental_models">;
};
export type HindsightEvidence = { id?: string; text?: string; type?: string; [key: string]: unknown };
export type HindsightResponse = {
  provider: "hindsight";
  text?: string;
  results?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
  based_on?: {
    memories?: HindsightEvidence[];
    mental_models?: HindsightEvidence[];
    directives?: string[];
  };
};
export type HindsightObservation = { id?: string; text?: string; [key: string]: unknown };
export type HindsightMentalModel = {
  id: string;
  name?: string;
  source_query?: string;
  sourceQuery?: string;
  content?: string;
  local_status?: "pending" | "creating" | "ready" | "failed" | string;
  local_error?: string;
  [key: string]: unknown;
};
export type HindsightSyncResponse = {
  queued?: boolean;
  status?: HindsightEngineStatus["status"];
  provider?: "hindsight";
  pending?: number;
  error?: string;
};
export type HindsightOperation = { operation_id?: string; operationId?: string; queued?: boolean };
