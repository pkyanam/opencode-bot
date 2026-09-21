import { Check, LoaderCircle, X, CircleStop } from "lucide-react";
import { useEffect, useState } from 'react';
import type { Run, ToolPart } from "../api";
import { toolActionLabel } from "./tool-activity";
const ACTIVE=['queued','provisioning','running','waiting_approval','waiting_human','recovering','checkpointing','cancelling'];
export function RunProgress({run,tools=[]}:{run:Run;tools?:ToolPart[]}) {
  const running=ACTIVE.includes(run.status);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running]);
  const started=Date.parse(run.createdAt??'') || 0;
  const recent=tools.filter(tool=>tool.startedAt && Date.parse(tool.startedAt)>=started);
  const current=[...recent].reverse().find(tool=>['running','queued'].includes(tool.status));
  const seconds=started?Math.max(0,Math.floor(((running?now:Date.parse(run.updatedAt??'')||now)-started)/1000)):0;
  const elapsed=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
  const interrupted=Boolean(run.error && /transport|connection|socket/i.test(run.error));
  const titles:Record<string,string>={queued:'Waiting for the computer',provisioning:'Starting the computer',running:current?toolActionLabel(current.name):'Preparing a response',waiting_approval:'Waiting for approval',waiting_human:'Waiting for your input',recovering:'Reconnecting',checkpointing:'Saving computer state',cancelling:'Stopping',succeeded:'Completed',failed:interrupted?'Response interrupted':'Could not complete this request',cancelled:'Stopped',needs_review:'Needs your attention'};
  const failed=['failed','needs_review'].includes(run.status);
  return <section className={`run-progress ${running?'progress-active':''} ${failed?'progress-failed':''}`} aria-label="Task progress">
    <div className="progress-heading"><span className="progress-mark">{running?<LoaderCircle size={15} className="spin"/>:failed?<X size={15}/>:run.status==='cancelled'?<CircleStop size={15}/>:<Check size={15}/>}</span>
    <div><strong>{titles[run.status]??run.status.replaceAll('_',' ')}</strong><span>{elapsed}{recent.length?` · ${recent.length} tool action${recent.length===1?'':'s'}`:running?' · No tool actions yet':' · No tool actions recorded'}</span></div></div>
    {run.error&&<p className="progress-error">{interrupted?'The model connection ended before the response completed.':run.error}</p>}
  </section>;
}
