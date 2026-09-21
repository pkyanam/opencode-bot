import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ToolActivity} from './components/tool-activity';
import {RunProgress, classifyRunActivity} from './components/run-progress';

it('renders a readable inline tool action and keeps large results collapsed',()=>{
 const html=renderToStaticMarkup(createElement(ToolActivity,{part:{type:'tool',id:'t',name:'computer_browser_browser_navigate',status:'completed',input:{url:'https://opencode.ai'},output:'Page title: OpenCode\n'+'x'.repeat(20000)}}));
 expect(html).toContain('Open page');expect(html).toContain('https://opencode.ai');expect(html).not.toContain('computer_browser_browser_navigate');expect(html).not.toContain('x'.repeat(1000));expect(html).toContain('aria-expanded="false"');
});
it('reports the current tool without duplicating its output or using a historical action',()=>{
 const html=renderToStaticMarkup(createElement(RunProgress,{run:{id:'r',threadId:'thread',status:'running',createdAt:'2026-09-21T00:00:00Z'},tools:[{type:'tool',id:'old',name:'read',status:'completed',startedAt:'2026-09-20T00:00:00Z',output:'old output'},{type:'tool',id:'new',name:'shell',status:'running',startedAt:'2026-09-21T00:01:00Z'}]}));
 expect(html).toContain('Run command');expect(html).toContain('1 tool action');expect(html).not.toContain('old output');expect(html).not.toContain('Working on your request');
});
it('uses readable browser labels and omits protocol headings from collapsed previews',()=>{
 const html=renderToStaticMarkup(createElement(ToolActivity,{part:{type:'tool',id:'console',name:'computer_browser_browser_console_messages',status:'completed',output:'### Result\nNo console errors'}}));
 expect(html).toContain('Check browser console');expect(html).toContain('No console errors');expect(html).not.toContain('### Result');
});
it('labels a fresh reasoning stream as thinking without rendering its private delta',()=>{
 const now=Date.parse('2026-09-21T00:01:05Z');
 const run={id:'r',threadId:'thread',status:'running',createdAt:'2026-09-21T00:00:00Z',events:[{type:'runner.session.reasoning.delta',createdAt:'2026-09-21T00:01:04Z',payload:{delta:'private thoughts'}}]};
 expect(classifyRunActivity(run,now)).toMatchObject({kind:'thinking',ageSeconds:1});
 const html=renderToStaticMarkup(createElement(RunProgress,{run,now}));
 expect(html).toContain('Thinking');
 expect(html).not.toContain('private thoughts');
});
it('distinguishes provider waiting, retries, and stale silence',()=>{
 const now=Date.parse('2026-09-21T00:01:05Z');
 const base={id:'r',threadId:'thread',status:'running',createdAt:'2026-09-21T00:00:00Z'};
 expect(classifyRunActivity({...base,events:[{type:'runner.provider.waiting',createdAt:'2026-09-21T00:01:04Z'}]},now).kind).toBe('provider');
 expect(classifyRunActivity({...base,events:[{type:'runner.session.retry.scheduled',createdAt:'2026-09-21T00:01:04Z'}]},now).kind).toBe('retry');
 expect(classifyRunActivity({...base,events:[{type:'runner.session.reasoning.delta',createdAt:'2026-09-21T00:00:00Z'}]},now).kind).toBe('silent');
});

it('shows fresh response text as writing rather than stale reasoning',()=>{
 const now=Date.parse('2026-09-21T00:01:05Z');
 const run={id:'r',threadId:'t',status:'running',events:[{type:'runner.session.reasoning.delta',createdAt:'2026-09-21T00:00:00Z'},{type:'runner.session.text.delta',createdAt:'2026-09-21T00:01:04Z'}]};
 expect(classifyRunActivity(run,now).kind).toBe('responding');
});

it('explains a blocked queue without counting another run’s tools', () => {
 const html=renderToStaticMarkup(createElement(RunProgress,{run:{id:'queued',threadId:'thread',status:'queued',createdAt:'2026-09-21T00:00:00Z',queue:{position:1,blockedBy:{id:'active',status:'waiting_approval',botName:'Dilan'}}},tools:[{type:'tool',id:'old',name:'shell',status:'running',startedAt:'2026-09-21T00:01:00Z'}]}));
 expect(html).toContain('Queued behind Dilan');
 expect(html).toContain('approval needed');
 expect(html).toContain('Not started');
 expect(html).not.toContain('tool action');
});
