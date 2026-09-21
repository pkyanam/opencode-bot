import type { Message } from "../api";

export type Delegation = {
  id: string;
  targetBotId: string;
  targetBotName: string;
  targetThreadId: string;
  prompt: string;
  status: string;
  result?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ConversationItem =
  | { kind: "message"; message: Message }
  | { kind: "delegation"; delegation: Delegation };

const time = (value?: string) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};

/** Place peer-bot handoffs beside the message that sent them. */
export function mergeDelegationTimeline(
  messages: Message[],
  delegations: Delegation[],
): ConversationItem[] {
  // Native transcript order is authoritative, including missing or skewed timestamps.
  const slots: Delegation[][] = Array.from({ length: messages.length + 1 }, () => []);
  for (const delegation of [...delegations].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    const timestamp = time(delegation.createdAt);
    const next = messages.findIndex(message => {
      const messageTime = time(message.createdAt);
      return messageTime !== Number.MAX_SAFE_INTEGER && messageTime > timestamp;
    });
    slots[next < 0 ? messages.length : next].push(delegation);
  }
  const result: ConversationItem[] = [];
  messages.forEach((message, index) => {
    result.push(...slots[index].map(delegation => ({ kind: "delegation" as const, delegation })));
    result.push({ kind: "message", message });
  });
  result.push(...slots[messages.length].map(delegation => ({ kind: "delegation" as const, delegation })));
  return result;
}
