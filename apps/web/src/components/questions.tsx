import { Button } from "./ui/button";
import { useEffect, useState } from 'react';
import { api } from '../api';

export type BotQuestion = { id: string; questions: {header: string; question: string; options: {label:string;description:string}[]; multiple?: boolean; custom?: boolean}[] };
export function RunQuestions({runId, active}: {runId:string;active:boolean}) {
  const [requests,setRequests] = useState<BotQuestion[]>([]);
  useEffect(() => {
    let cancelled=false, busy=false;
    setRequests([]);
    const load=async()=>{if(busy)return;busy=true;try{const result=await api.questions(runId);if(!cancelled)setRequests(Array.isArray(result.questions)?result.questions:[]);}catch{}finally{busy=false;}};
    if(active)void load();
    const timer=active?setInterval(()=>void load(),3000):undefined;
    return()=>{cancelled=true;clearInterval(timer);};
  },[runId,active]);
  return <>{requests.map(request=><QuestionCard key={request.id} request={request} onAnswer={async(answers)=>{await api.answerQuestions(runId,request.id,answers);setRequests(current=>current.filter(q=>q.id!==request.id));}} onSkip={async()=>{await api.rejectQuestions(runId,request.id);setRequests(current=>current.filter(q=>q.id!==request.id));}} />)}</>;
}
export function QuestionCard({request,onAnswer,onSkip}:{request:BotQuestion;onAnswer:(answers:string[][])=>Promise<void>;onSkip:()=>Promise<void>}) {
  const [selected,setSelected]=useState<string[][]>(()=>request.questions.map(()=>[]));
  const [custom,setCustom]=useState<string[]>(()=>request.questions.map(()=>''));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const answers=selected.map((values,i)=>custom[i]?.trim() ? request.questions[i].multiple ? [...values,custom[i].trim()] : [custom[i].trim()] : values);
  const submit=async(skip=false)=>{setBusy(true);setError('');try{if(skip)await onSkip();else await onAnswer(answers);}catch(e){setError(e instanceof Error?e.message:'Could not send your answer. Try again.');}finally{setBusy(false);}};
  return <section className="question-card" aria-label="Questions from your bot">
    {request.questions.map((question,i)=><fieldset key={i} disabled={busy}>
      <legend>{question.header}</legend><p>{question.question}</p>
      <div className="question-options">{question.options.map(option=><label key={option.label} className="question-option">
        <input type={question.multiple?'checkbox':'radio'} name={`${request.id}-${i}`} checked={selected[i].includes(option.label)} onChange={()=>{setSelected(current=>current.map((values,j)=>j!==i?values:question.multiple?values.includes(option.label)?values.filter(v=>v!==option.label):[...values,option.label]:[option.label]));if(!question.multiple)setCustom(current=>current.map((v,j)=>j===i?'':v));}} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}</div>
      {question.custom!==false&&<input className="question-custom" aria-label={`Your answer: ${question.header}`} placeholder="Or write your own answer…" value={custom[i]} onChange={event=>{const value=event.target.value;setCustom(current=>current.map((v,j)=>j===i?value:v));if(!question.multiple)setSelected(current=>current.map((v,j)=>j===i?[]:v));}} />}
    </fieldset>)}
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="question-actions"><Button variant="outline" disabled={busy} onClick={()=>void submit(true)}>Skip question</Button><Button disabled={busy||answers.some(answer=>!answer.length)} onClick={()=>void submit()}>{busy?'Sending…':'Send answer'}</Button></div>
  </section>;
}
