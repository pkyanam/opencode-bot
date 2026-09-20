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
