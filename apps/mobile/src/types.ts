export type Bot = {
  id: string;
  name: string;
  instructions?: string;
  model?: string;
  status?: string;
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
