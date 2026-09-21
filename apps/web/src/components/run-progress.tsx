import { Check, LoaderCircle, X, CircleStop } from "lucide-react";
import { useEffect, useState } from 'react';
import type { Run, ToolPart } from "../api";
import { toolActionLabel } from "./tool-activity";
const ACTIVE=['queued','provisioning','running','waiting_approval','waiting_human','waiting_dependency','recovering','checkpointing','cancelling'];

const FRESH_ACTIVITY_MS = 20_000;
type ProgressActivity = 'thinking' | 'provider' | 'retry' | 'responding' | 'working' | 'silent';
type ActivityEvent = { event: NonNullable<Run['events']>[number]; at: number };

function eventTime(event: NonNullable<Run['events']>[number]): number {
  const value = event.createdAt ? Date.parse(event.createdAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function latest(events: NonNullable<Run['events']>, match: (event: NonNullable<Run['events']>[number]) => boolean, fallback: number): ActivityEvent | undefined {
  const candidates = events.filter(match).map(event => ({event, at: eventTime(event) || fallback}));
  return candidates.sort((a,b) => a.at - b.at || Number((a.event as any).sequence ?? 0) - Number((b.event as any).sequence ?? 0)).at(-1);
}

/** Classify public lifecycle events without looking at or exposing reasoning text. */
export function classifyRunActivity(run: Run, now = Date.now()): { kind: ProgressActivity; lastActivityAt?: number; ageSeconds?: number } {
  const events = run.events ?? [];
  const fallback = Date.parse(run.updatedAt ?? '') || Date.parse(run.createdAt ?? '') || now;
  const reasoning = latest(events, event => /(?:^|\.)reasoning\.delta$/.test(event.type ?? ''), fallback);
  const retry = latest(events, event => /(?:retry\.scheduled|connection\.recovering|stream\.error|connection\.failed)$/.test(event.type ?? ''), fallback);
  const provider = latest(events, event => {
    const type = event.type ?? '';
    const payload = (event.payload ?? event.data ?? {}) as any;
    return /provider\.(?:waiting|queued|pending|busy)/i.test(type) || (/session\.status$/i.test(type) && /^(waiting|pending|retry|queued)$/i.test(String(payload.status ?? payload.state ?? '')));
  }, fallback);
  const responding = latest(events, event => /(?:^|\.)text\.delta$/.test(event.type ?? ''), fallback);
  const candidates = [responding && {...responding, kind:'responding' as const}, reasoning && {...reasoning, kind:'thinking' as const}, retry && {...retry, kind:'retry' as const}, provider && {...provider, kind:'provider' as const}].filter(Boolean) as Array<ActivityEvent & {kind: Exclude<ProgressActivity,'silent'>}>;
  const current = candidates.sort((a,b) => a.at - b.at).at(-1);
  const lastActivityAt = events.length ? Math.max(...events.map(event => eventTime(event) || fallback)) : undefined;
  if (!lastActivityAt) return {kind:'silent'};
  const ageSeconds = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  if (now - lastActivityAt > FRESH_ACTIVITY_MS) return {kind:'silent', lastActivityAt, ageSeconds};
  if (!current || current.at < lastActivityAt) return {kind:'working', lastActivityAt, ageSeconds};
  return {kind:current.kind, lastActivityAt, ageSeconds};
}

export function RunProgress({run,tools=[],now: clockNow}: {run:Run;tools?:ToolPart[];now?:number}) {
  const running=ACTIVE.includes(run.status);
  const [now,setNow]=useState(clockNow ?? Date.now());
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running]);
  const currentNow = clockNow ?? now;
  const started=Date.parse(run.startedAt??run.createdAt??'') || 0;
  const queued=run.status==='queued'||run.status==='waiting_dependency';
  const ended=running?Infinity:Date.parse(run.updatedAt??'')||Infinity;
  const recent=queued?[]:tools.filter(tool=>tool.startedAt && Date.parse(tool.startedAt)>=started && Date.parse(tool.startedAt)<=ended);
  const current=[...recent].reverse().find(tool=>['running','queued'].includes(tool.status));
  const seconds=started?Math.max(0,Math.floor(((running?currentNow:Date.parse(run.updatedAt??'')||currentNow)-started)/1000)):0;
  const elapsed=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
  const interrupted=Boolean(run.error && /transport|connection|socket/i.test(run.error));
  const activity=run.status==='running' ? classifyRunActivity(run, currentNow) : {kind:'silent' as const};
  const runningTitle = current ? toolActionLabel(current.name) : activity.kind==='thinking' ? 'Thinking' : activity.kind==='responding' ? 'Writing a response' : activity.kind==='working' ? 'Working' : activity.kind==='provider' ? 'Waiting for the model provider' : activity.kind==='retry' ? 'Retrying the model connection' : run.events?.length ? 'No recent activity' : 'Preparing a response';
  const blocker=run.queue?.blockedBy;
  const queueTitle=run.queue?.reconnecting
    ? `Reconnecting to the computer${blocker ? ` · queued behind ${blocker.botName}${blocker.status==='waiting_approval'?' — approval needed':''}` : ''}`
    : blocker ? `Queued behind ${blocker.botName}${blocker.status==='waiting_approval'?' — approval needed':''}` : (run.queue?.position??1)>1 ? `Queued · position ${run.queue?.position}` : 'Waiting for the computer';
  const titles:Record<string,string>={queued:queueTitle,waiting_dependency:'Computer needs attention',provisioning:'Starting the computer',running:runningTitle,waiting_approval:'Waiting for approval',waiting_human:'Waiting for your input',recovering:'Reconnecting',checkpointing:'Saving computer state',cancelling:'Stopping',succeeded:'Completed',failed:interrupted?'Response interrupted':'Could not complete this request',cancelled:'Stopped',needs_review:'Needs your attention'};
  const guidance = run.status === 'recovering' || run.queue?.reconnecting
    ? 'The computer connection is recovering. The task is paused; refresh to check the current run state.'
    : run.status === 'needs_review'
      ? 'This run needs attention. Refresh to load the latest state before taking any action.'
      : run.status === 'waiting_approval' && !run.approval && !run.approvalRequest && !run.pendingApproval && !run.approvals?.length
        ? 'Approval details are still loading. Refresh to review the permission request.'
        : undefined;
  const activityAge=activity.ageSeconds !== undefined ? ` · last activity ${activity.ageSeconds < 60 ? `${activity.ageSeconds}s` : `${Math.floor(activity.ageSeconds/60)}m`} ago` : '';
  const failed=['failed','needs_review'].includes(run.status);
  return <section className={`run-progress ${running?'progress-active':''} ${failed?'progress-failed':''}`} aria-label="Task progress">
    <div className="progress-heading"><span className="progress-mark">{running?<LoaderCircle size={15} className="spin"/>:failed?<X size={15}/>:run.status==='cancelled'?<CircleStop size={15}/>:<Check size={15}/>}</span>
    <div><strong>{titles[run.status]??run.status.replaceAll('_',' ')}</strong><span>{elapsed}{recent.length?` · ${recent.length} tool action${recent.length===1?'':'s'}`:queued?' · Not started':running?' · No tool actions yet':' · No tool actions recorded'}{running && activityAge}</span></div></div>
    {guidance && <p className="progress-guidance">{guidance}</p>}
    {run.error&&<p className="progress-error">{interrupted?'The model connection ended before the response completed.':run.error}</p>}
  </section>;
}
