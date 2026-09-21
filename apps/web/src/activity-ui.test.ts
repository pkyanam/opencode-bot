import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ToolActivity} from './components/tool-activity';
import {RunProgress} from './components/run-progress';

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
