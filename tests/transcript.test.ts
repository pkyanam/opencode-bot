import { describe, expect, it } from 'vitest';
import { normalizeNativeMessages } from '../apps/web/src/lib/transcript';
describe('native transcript', () => {
  it('orders newest-first native records chronologically and preserves provider errors', () => {
    const output = normalizeNativeMessages([
      { id:'3', type:'idle', time:{created:300}},
      { id:'2', type:'assistant', content:[], error:{type:'provider.transport',message:'Certificate verification failed'}, time:{created:200}},
      { id:'1', type:'user', text:'Hello', time:{created:100}},
    ]);
    expect(output.map(m=>m.id)).toEqual(['1','2']);
    expect(output[1].error).toBe('Certificate verification failed');
  });
  it('omits empty non-error assistant records without mutating the native result', () => {
    const source = [{id:'2',type:'assistant',content:[],time:{created:200}},{id:'1',type:'user',text:'Hi',time:{created:100}}];
    expect(normalizeNativeMessages(source).map(m=>m.id)).toEqual(['1']);
    expect(source[0].id).toBe('2');
  });
});

it('preserves tool-only activity and interleaves text with the latest tool state', () => {
  const messages=normalizeNativeMessages([{id:'m1',type:'assistant',time:{created:100},content:[
    {type:'text',text:'Opening the page.'},
    {type:'reasoning',text:'Private internal reasoning'},
    {type:'tool',id:'t1',name:'computer_browser_browser_navigate',state:{status:'running',input:{url:'https://example.com'}},time:{created:101}},
    {type:'tool',id:'t1',name:'computer_browser_browser_navigate',state:{status:'completed',input:{url:'https://example.com'},content:[{type:'text',text:'Page title: Example'},{type:'image',data:'base64'}]},time:{created:101,completed:200}},
    {type:'text',text:'The page is ready.'},
  ]},{id:'m2',type:'assistant',time:{created:300},content:[{type:'tool',id:'t2',name:'shell',state:{status:'running',input:{command:'npm test'}}}]}]);
  expect(messages).toHaveLength(2);
  expect(messages[0].parts?.map(p=>p.type)).toEqual(['text','tool','text']);
  expect(messages[0].parts?.[1]).toMatchObject({name:'computer_browser_browser_navigate',status:'completed',output:'Page title: Example'});
  expect(messages[1].parts?.[0]).toMatchObject({name:'shell',status:'running'});
  expect(JSON.stringify(messages)).not.toContain('Private internal reasoning');
  expect(JSON.stringify(messages)).not.toContain('base64');
});

it('bounds tool output and hides credential fields while retaining a useful error', () => {
  const [message]=normalizeNativeMessages([{id:'m',type:'assistant',content:[{type:'tool',id:'t',name:'request',state:{status:'error',input:{headers:{Authorization:'Bearer secret'},api_key:'secret',url:'https://example.com?token=hidden'},error:'Connection refused',content:[{type:'text',text:'x'.repeat(40000)}]}}]}]);
  const tool=message.parts?.[0];
  expect(tool).toMatchObject({status:'failed',error:'Connection refused',input:{headers:{Authorization:'[redacted]'},api_key:'[redacted]',url:'https://example.com?token=[redacted]'}});
  expect(tool?.type==='tool' && tool.output!.length).toBeLessThan(16100);
});

it('interleaves readable lifecycle notices without leaking raw event payloads', async () => {
 const {mergeActivityMessages}=await import('../apps/web/src/lib/transcript');
 const result=mergeActivityMessages([{id:'m',role:'assistant',content:'Checking the page.',createdAt:'2026-09-21T00:00:00Z'}],[{id:'r',threadId:'t',status:'running',events:[{id:'e',type:'runner.session.retry.scheduled',createdAt:'2026-09-21T00:00:01Z',payload:{attempt:2,error:{secret:'never show'}}},{id:'r',type:'runner.session.reasoning.delta',payload:{delta:'private reasoning'}}]}]);
 expect(result.map(m=>m.role)).toEqual(['assistant','system']);expect(result[1].content).toContain('attempt 2');expect(JSON.stringify(result)).not.toContain('never show');expect(JSON.stringify(result)).not.toContain('private reasoning');
});

it('interrupts tools owned by a terminal run without interrupting a newer run', async () => {
  const {mergeActivityMessages}=await import('../apps/web/src/lib/transcript');
  const messages=normalizeNativeMessages([
    {id:'old-message',type:'assistant',time:{created:Date.parse('2026-09-21T00:00:05Z')},content:[{type:'tool',id:'old-tool',name:'shell',state:{status:'running'},time:{created:Date.parse('2026-09-21T00:00:06Z')}}]},
    {id:'new-message',type:'assistant',time:{created:Date.parse('2026-09-21T00:01:05Z')},content:[{type:'tool',id:'new-tool',name:'computer',state:{status:'running'},time:{created:Date.parse('2026-09-21T00:01:06Z')}}]},
  ]);
  const result=mergeActivityMessages(messages,[
    {id:'old-run',threadId:'t',status:'succeeded',createdAt:'2026-09-21T00:00:00Z'},
    {id:'new-run',threadId:'t',status:'running',createdAt:'2026-09-21T00:01:00Z'},
  ]);
  const tools=result.flatMap(message=>message.parts?.filter(part=>part.type==='tool') ?? []);
  expect(tools).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'old-tool',status:'interrupted'}),
    expect.objectContaining({id:'new-tool',status:'running'}),
  ]));
});
