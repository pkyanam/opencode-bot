import { expect, it } from 'vitest';
import { parsePairingInput } from '../apps/mobile/src/pairing-input';
it('extracts server and one-time secret together from browser QR invitations', () => {
 expect(parsePairingInput('https://bot.example/#pair=ps_abc-123')).toEqual({baseUrl:'https://bot.example',credential:'ps_abc-123'});
 expect(parsePairingInput(' AB12-CD34 ')).toEqual({credential:'AB12-CD34'});
});
it('rejects unrelated and malformed invitation URLs without decoding crashes', () => {
 expect(()=>parsePairingInput('https://bot.example/#pair=%E0%A4%A')).toThrow();
 expect(()=>parsePairingInput('https://bot.example/#token=owner-token')).toThrow();
 expect(()=>parsePairingInput('https://user:password@bot.example/#pair=ps_abc')).toThrow();
});
