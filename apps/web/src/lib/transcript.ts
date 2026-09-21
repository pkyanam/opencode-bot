import type { Attachment, Message, MessagePart, ToolPart } from "../api";

const secretKey = /(?:authorization|password|passwd|secret|token|api[_-]?key|cookie|credential)/i;
function redactText(value: string, limit = 16000): string {
  return value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s"']+/gi, '$1[redacted]')
    .slice(0, limit) + (value.length > limit ? '\n… output shortened' : '');
}
/** Bounded readable tool details. Never render credential fields or binary payloads. */
export function safeToolDetail(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[nested details omitted]';
  if (typeof value === 'string') return redactText(value, 4000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeToolDetail(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : safeToolDetail(item, depth + 1)]));
  return undefined;
}
function timestamp(value: unknown): string | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(number) ? new Date(number).toISOString() : undefined;
}
function toolPart(part: any, fallbackId: string): ToolPart {
  const state = part.state ?? {};
  const status = state.status ?? part.status;
  const failed = ['error','failed','cancelled'].includes(status) || state.metadata?.error === true || Boolean(state.error);
  const output = Array.isArray(state.content) ? state.content.filter((item: any) => item.type === 'text' && typeof item.text === 'string').map((item: any) => item.text).join('\n') : typeof state.output === 'string' ? state.output : '';
  const error = state.error ? typeof state.error === 'string' ? state.error : state.error.message : undefined;
  return {
    type: 'tool', id: String(part.id ?? fallbackId), name: String(part.name ?? part.tool ?? 'tool'),
    status: failed ? 'failed' : ['completed','succeeded','success'].includes(status) ? 'completed' : ['pending','queued'].includes(status) ? 'queued' : 'running',
    input: safeToolDetail(state.input ?? part.input),
    ...(output ? { output: redactText(output) } : {}),
    ...(error ? { error: redactText(String(error), 1000) } : {}),
    startedAt: timestamp(part.time?.ran ?? part.time?.created), finishedAt: timestamp(part.time?.completed),
  };
}

/** Preserve public messages and ordered tool activity; never surface raw reasoning. */
export function normalizeNativeMessages(input: any[]): Message[] {
  return input.filter(m => m.type === 'user' || m.type === 'assistant').slice()
    .sort((a,b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map((m): Message => {
      const parts: MessagePart[] = [];
      const toolPositions = new Map<string, number>();
      const attachments: Attachment[] = [];
      const addAttachment = (part: any) => {
        const nativeAttachmentId = String(part?.id ?? part?.fileId ?? '').match(/^att_[0-9a-f-]{20,80}$/i)?.[0] ?? String(part?.url ?? part?.uri ?? part?.source ?? '').match(/(?:^|\/)uploads\/(att_[0-9a-f-]{20,80})(?:\/|$)/i)?.[1];
        if (!nativeAttachmentId) return;
        if (attachments.some(item => item.id === nativeAttachmentId)) return;
        attachments.push({ id: nativeAttachmentId, name: String(part?.name ?? part?.filename ?? 'Attachment'), mimeType: String(part?.mimeType ?? part?.mime ?? 'application/octet-stream'), size: Number(part?.size ?? 0) || 0 });
      };
      for (const attachment of [...(m.attachments ?? []), ...(m.files ?? [])]) addAttachment(attachment);
      if (m.type === 'user') parts.push({type:'text', text:String(m.text ?? '')});
      else { for (const [index, part] of (m.content ?? []).entries()) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) parts.push({type:'text',text:part.text});
        if (part.type === 'tool') {
          const tool = toolPart(part, `${m.id}-tool-${index}`);
          const position = toolPositions.get(tool.id);
          if (position === undefined) { toolPositions.set(tool.id, parts.length); parts.push(tool); }
          else parts[position] = tool;
        }
        if (part.type === 'file' || part.type === 'image') addAttachment(part);
      } }
      if (m.type === 'user') for (const part of m.content ?? []) if (part.type === 'file' || part.type === 'image') addAttachment(part);
      return { id:m.id, role:m.type, parts, ...(attachments.length ? {attachments} : {}), content:parts.filter((part): part is {type:'text',text:string} => part.type==='text').map(part=>part.text).join('\n'), createdAt:timestamp(m.time?.created),
        ...(m.error ? {error:typeof m.error==='string'?m.error:String(m.error.message??m.error.type??'OpenCode could not complete this request.')} : {}) };
    }).filter(m => m.content.trim() || m.attachments?.length || m.parts?.some(part=>part.type==='tool') || m.error);
}

/** Public lifecycle notices belong beside chat/tool messages, never raw events. */
export function mergeActivityMessages(messages: Message[], runs: import('../api').Run[]): Message[] {
  const notices: Message[] = [];
  for (const run of runs) {
    const seen = new Set<string>();
    for (const event of run.events ?? []) {
      const type=event.type ?? '';
      const payload=event.payload ?? event.data ?? {};
      let content='';
      if (type.endsWith('session.retry.scheduled')) content=`The model connection was interrupted. Retrying${payload.attempt ? ` (attempt ${payload.attempt})` : ''}…`;
      else if(type==='runner.connection.recovering') content=`Reconnecting to the running task${payload.attempt ? ` (attempt ${payload.attempt})` : ''}…`;
      else if(type==='runner.approval.requested') content='Waiting for your approval to continue.';
      else if(type==='runner.connection.failed') content='The computer could not connect securely to the model. Retries stopped.';
      else if(type==='runner.session.action.completed') content=`${payload.action === 'compact' ? 'Conversation context compacted' : 'Conversation action completed'}.`;
      else if(type==='run.cancelled') content='You stopped this task.';
      if(!content || seen.has(content)) continue;
      seen.add(content);
      notices.push({id:`activity-${event.id ?? `${run.id}-${type}`}`,role:'system',content,createdAt:event.createdAt ?? run.updatedAt});
    }
  }
  const orderedRuns = [...runs].sort((a,b)=>(a.createdAt??'').localeCompare(b.createdAt??''));
  const settledMessages = messages.map(message=>({...message, parts:message.parts?.map(part=>{
    if(part.type !== 'tool' || !['running','queued'].includes(part.status)) return part;
    const started = part.startedAt ?? message.createdAt;
    const owner = started ? orderedRuns.filter(run=>!['queued','waiting_dependency'].includes(run.status) && (run.startedAt??run.createdAt) && (run.startedAt??run.createdAt)! <= started).at(-1) : undefined;
    if(!owner || !['failed','cancelled','succeeded','needs_review'].includes(owner.status)) return part;
    return {...part, status:'interrupted' as const, error:part.error ?? 'This task ended before the tool reported a result.'};
  })}));
  return [...settledMessages,...notices].sort((a,b)=>(a.createdAt??'').localeCompare(b.createdAt??'') || (a.id??'').localeCompare(b.id??''));
}
