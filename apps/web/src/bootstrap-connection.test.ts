import { describe, it, expect, vi } from 'vitest';
import { consumeConnectionFragment } from './lib/bootstrap-connection';

describe('installer connection handoff', () => {
  it('strips the credential fragment before storing a valid owner token', () => {
    const calls:string[]=[];
    const token='a'.repeat(43);
    const replaceState=vi.fn(()=>calls.push('strip'));
    const setItem=vi.fn(()=>calls.push('store'));
    consumeConnectionFragment({hash:'#connect='+token,pathname:'/',search:''},{replaceState},{setItem});
    expect(replaceState).toHaveBeenCalledWith(null,'','/');
    expect(setItem).toHaveBeenCalledWith('opencode-bot-app-token',token);
    expect(calls).toEqual(['strip','store']);
  });
  it('removes malformed credentials without replacing an existing connection', () => {
    const replaceState=vi.fn(),setItem=vi.fn();
    consumeConnectionFragment({hash:'#connect=bad&redirect=other',pathname:'/',search:''},{replaceState},{setItem});
    expect(replaceState).toHaveBeenCalledOnce();expect(setItem).not.toHaveBeenCalled();
  });
  it.each(['#connect=', '#token='])('accepts existing Boat UUID credentials via %s', prefix => {
    const token='12345678-1234-4234-8234-123456789abc';
    const replaceState=vi.fn(),setItem=vi.fn();
    consumeConnectionFragment({hash:prefix+token,pathname:'/',search:''},{replaceState},{setItem});
    expect(setItem).toHaveBeenCalledWith('opencode-bot-app-token',token);
    expect(replaceState).toHaveBeenCalledOnce();
  });
  it('leaves ordinary hash navigation alone', () => {
    const replaceState=vi.fn(),setItem=vi.fn();
    consumeConnectionFragment({hash:'#skills',pathname:'/',search:''},{replaceState},{setItem});
    expect(replaceState).not.toHaveBeenCalled();expect(setItem).not.toHaveBeenCalled();
  });
});
