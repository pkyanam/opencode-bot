import { expect, it } from 'vitest';
import { clientPayload } from './client-payload';
it('removes nested image bytes from tool results while retaining readable output and file metadata', () => {
  const binary = 'A'.repeat(2_000_000);
  const input = { content: [{ type: 'tool', state: { content: [{type:'text',text:'Image read successfully'}, {type:'file',uri:`data:image/jpeg;base64,${binary}`}, {type:'image',data:binary,mimeType:'image/jpeg'}] } }], attachments: [{id:'att_123',name:'photo.jpg',size:1500000}] };
  const safe = clientPayload(input);
  expect(JSON.stringify(safe).length).toBeLessThan(1000);
  expect(safe.content[0].state.content[0].text).toBe('Image read successfully');
  expect(safe.attachments).toEqual(input.attachments);
  expect(input.content[0].state.content[1].uri).toContain(binary);
});
it('strips data URLs embedded inside serialized tool output without altering ordinary links or prose', () => {
  expect(clientPayload({output:'{"uri":"data:image/png;base64,aGVsbG8="}',text:'See https://example.org/photo.png'})).toEqual({output:'{"uri":"[inline binary omitted]"}',text:'See https://example.org/photo.png'});
});
