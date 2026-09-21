import {describe,it,expect} from 'vitest';
import {telegramActivity} from '../apps/control-worker/src/telegram-activity';
describe('Telegram public activity',()=>{
 it('shows current-turn commentary and tools without private reasoning or raw payloads',()=>{
  const text=telegramActivity({status:'running',created_at:'2026-09-21T00:00:00Z'},[
   {type:'assistant',time:{created:1},content:[{type:'text',text:'old turn'}]},
   {type:'assistant',time:{created:Date.parse('2026-09-21T00:01:00Z')},content:[{type:'text',text:'Opening the page now.'},{type:'reasoning',text:'private thoughts'},{type:'tool',name:'computer_browser_browser_navigate',state:{status:'completed',input:{token:'secret'},content:[{type:'text',text:'raw output'}]}}]}
  ]);
  expect(text).toContain('Opening the page now.');expect(text).toContain('✓ Opened a page');
  for(const omitted of ['old turn','private thoughts','secret','raw output']) expect(text).not.toContain(omitted);
 });
 it('bounds long public activity',()=>{expect(telegramActivity({status:'running'},Array.from({length:20},()=>({type:'assistant',content:[{type:'text',text:'x'.repeat(10000)}]}))).length).toBeLessThanOrEqual(2600)});
});
it('orders messages by creation time and names completed shell commands',()=>{
 const text=telegramActivity({status:'running'},[
  {id:'b',type:'assistant',time:{created:2},content:[{type:'tool',name:'shell',state:{status:'completed',input:{command:'pwd'}}}]},
  {id:'a',type:'assistant',time:{created:1},content:[{type:'text',text:'Checking the workspace.'}]}
 ]);
 expect(text.indexOf('Checking the workspace.')).toBeLessThan(text.indexOf('✓ Ran pwd'));
});
