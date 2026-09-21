import { describe, expect, it } from 'vitest';
import { normalizeComputerPoint, translateComputerKey } from './components/interactive-computer';
describe('remote desktop input mapping', () => {
  it('maps the image content rather than the letterboxed container', () => {
    expect(normalizeComputerPoint({clientX:250,clientY:250},{left:0,top:0,width:500,height:500},1000,500)).toEqual({x:0.5,y:0.5});
    expect(normalizeComputerPoint({clientX:500,clientY:375},{left:0,top:0,width:500,height:500},1000,500)).toEqual({x:1,y:1});
  });
  it('preserves punctuation and case for login fields without duplicate keyup input', () => {
    for (const key of ['@','!','A','é']) {
      expect(translateComputerKey({key},'down')).toEqual([{type:'text',text:key}]);
      expect(translateComputerKey({key},'up')).toEqual([]);
    }
  });
  it('maps Mac browser shortcuts to the Linux desktop and keeps reverse tab navigation', () => {
    expect(translateComputerKey({key:'l',metaKey:true},'down')).toEqual([{type:'key',action:'press',key:'Control+L'}]);
    expect(translateComputerKey({key:'Tab',shiftKey:true},'down')).toEqual([{type:'key',action:'press',key:'Shift+Tab'}]);
  });
});
