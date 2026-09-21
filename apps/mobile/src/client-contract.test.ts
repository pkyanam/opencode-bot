import { afterEach, expect, it, vi } from 'vitest';
const storage=vi.hoisted(()=>({clearConnection:vi.fn(async()=>{}),readToken:vi.fn(async()=>null)}));
vi.mock('./storage',()=>storage);
vi.mock('expo-file-system',()=>({File: class {}}));
import { api, request, setCachedToken, onAuthInvalidated } from './api';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();setCachedToken(null)});
it('never sends an existing workspace token during pairing or clears it on a rejected invitation',async()=>{
 setCachedToken('existing-private-token');
 const fetcher=vi.fn(async(_url: string, _init?: RequestInit)=>Response.json({error:'Invitation expired'},{status:401}));vi.stubGlobal('fetch',fetcher);
 await expect(api('https://new.example').redeem('ABCD-1234','Phone')).rejects.toThrow('Invitation expired');
 expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
 expect(storage.clearConnection).not.toHaveBeenCalled();
});
it('invalidates the connection on authenticated 401 and rejects insecure remote URLs before sending',async()=>{
 const invalidated=vi.fn();const remove=onAuthInvalidated(invalidated);setCachedToken('device-token');
 const fetcher=vi.fn(async()=>Response.json({error:'revoked'},{status:401}));vi.stubGlobal('fetch',fetcher);
 await expect(api('http://remote.example').state()).rejects.toThrow('HTTPS');expect(fetcher).not.toHaveBeenCalled();
 await expect(api('https://bot.example').state()).rejects.toThrow('revoked');
 expect(storage.clearConnection).toHaveBeenCalledOnce();expect(invalidated).toHaveBeenCalledOnce();remove();
});
it('renders native message text, roles, files, and nested tool state',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({messages:[{id:'u',type:'user',text:'Read this',files:[{id:'att_1',name:'notes.txt'}]},{id:'a',type:'assistant',content:[{type:'text',text:'Checking'},{type:'tool',name:'read',state:{status:'completed',output:'Found file'}}]}]})));
 const result=await api('https://bot.example').messages('thread');
 expect(result.messages[0]).toMatchObject({role:'user',content:'Read this',attachments:[{id:'att_1'}]});
 expect(result.messages[1]).toMatchObject({role:'assistant',content:'Checking',parts:[{type:'text'},{type:'tool',status:'completed',output:'Found file'}]});
});
it('aborts requests that exceed the timeout',async()=>{
 vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))));
 await expect(request('https://bot.example','/api/state',{timeoutMs:5})).rejects.toThrow();
});
