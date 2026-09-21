/** Public activity only: omit model reasoning, raw inputs, outputs and credentials. */
export function telegramActivity(run: {status: string; created_at?: string}, messages: any[]): string {
  const labels: Record<string,string> = {queued:'Waiting for the computer',provisioning:'Starting the computer',running:'Preparing a response',waiting_approval:'Waiting for your approval — use the app to respond',cancelling:'Stopping',succeeded:'Completed',failed:'Could not complete the request',needs_review:'Connection interrupted — open the app for details',cancelled:'Stopped'};
  const actions: Record<string,string> = {browser_navigate:'Opening a page',browser_snapshot:'Inspecting a page',browser_click:'Clicking a page element',browser_evaluate:'Checking page state',browser_console_messages:'Checking browser console',browser_take_screenshot:'Taking a screenshot',browser_wait_for:'Waiting for the page',shell:'Running a command',read:'Reading a file',write:'Writing a file',edit:'Editing a file',glob:'Finding files',grep:'Searching files',webfetch:'Fetching a page',websearch:'Searching the web',bots_list_bots:'Finding bots',bots_send_message:'Messaging another bot',bots_get_replies:'Reading bot replies',bots_create_bot:'Creating a bot'};
  const entries:string[]=[];
  const start=Date.parse(run.created_at??'') || 0;
  for(const message of [...messages].sort((a,b)=>(a.time?.created??0)-(b.time?.created??0) || String(a.id??'').localeCompare(String(b.id??'')))) {
    if(message.type!=='assistant' || Number(message.time?.created??0)<start) continue;
    for(const part of message.content??[]) {
      if(part.type==='text' && typeof part.text==='string' && part.text.trim()) entries.push(part.text.trim().slice(0,600));
      if(part.type==='tool') {
        const name=String(part.name??part.tool??'').toLowerCase();
        const key=Object.keys(actions).sort((a,b)=>b.length-a.length).find(key=>name===key || name.endsWith('_'+key));
        const state=part.state?.status;
        let action=key?actions[key]:'Using a tool';
        if(key==='shell') {
          const command=String(part.state?.input?.command??'').match(/^([a-zA-Z0-9_./-]+)/)?.[1]?.split('/').at(-1);
          if(command) action=`Running ${command}`;
        }
        if(state==='completed') {
          const past:Record<string,string>={Opening:'Opened',Inspecting:'Inspected',Clicking:'Clicked',Checking:'Checked',Taking:'Took',Waiting:'Waited for',Running:'Ran',Reading:'Read',Writing:'Wrote',Editing:'Edited',Finding:'Found',Searching:'Searched',Fetching:'Fetched',Messaging:'Messaged',Using:'Used'};
          action=action.replace(/^\w+/,word=>past[word]??word);
        }
        entries.push(`${state==='completed'?'✓ ':state==='error'?'Failed: ':''}${action}`);
      }
    }
  }
  return [labels[run.status]??'Working',...entries.slice(-6)].join('\n\n').slice(0,2600);
}
