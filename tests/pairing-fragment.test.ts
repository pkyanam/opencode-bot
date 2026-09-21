import { describe, expect, it, vi } from 'vitest';
import { consumePairingFragment } from '../apps/web/src/lib/pairing-fragment';
describe('pairing bootstrap',()=>{
 it('removes the QR secret from the address immediately',()=>{const replaceState=vi.fn();expect(consumePairingFragment({hash:'#pair=ps_'+ 'a'.repeat(64),pathname:'/',search:''},{replaceState})).toBe('ps_'+'a'.repeat(64));expect(replaceState).toHaveBeenCalledWith(null,'','/');});
 it('clears malformed pairing links without affecting unrelated navigation',()=>{const replaceState=vi.fn();expect(consumePairingFragment({hash:'#pair=bad!',pathname:'/',search:''},{replaceState})).toBe('');expect(replaceState).toHaveBeenCalledTimes(1);expect(consumePairingFragment({hash:'#section',pathname:'/',search:''},{replaceState})).toBeUndefined();expect(replaceState).toHaveBeenCalledTimes(1);});
});
