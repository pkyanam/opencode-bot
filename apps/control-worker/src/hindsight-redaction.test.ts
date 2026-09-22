import { describe, expect, it } from "vitest";
import { redactHindsightText } from "./hindsight-redaction";

describe("Hindsight credential redaction", () => {
  it("redacts quoted JSON keys and preserves surrounding content", () => {
    const result = redactHindsightText('{"apiKey":"secret-value","password": "p a s s"} deploy');
    expect(result).toContain('"apiKey":"[redacted]"');
    expect(result).toContain('"password": "[redacted]"');
    expect(result).toContain("deploy");
    expect(result).not.toContain("secret-value");
    expect(result).not.toContain("p a s s");
  });

  it("redacts authorization and bearer credentials in headers and prose", () => {
    const result = redactHindsightText("Authorization: Bearer abcdefghijklmnop\nBearer zyxwvutsrqponmlk");
    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("zyxwvutsrqponmlk");
    expect(result).toContain("Authorization: [redacted]");
    expect(result).toContain("Bearer [redacted]");
  });

  it("redacts common unlabeled provider keys and private keys", () => {
    const result = redactHindsightText(`sk-${"a".repeat(20)} AKIA1234567890ABCD12 -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`);
    expect(result).not.toMatch(/sk-a{20}|AKIA1234567890ABCD12|BEGIN PRIVATE KEY/);
    expect(result).toContain("[redacted key]");
    expect(result).toContain("[redacted private key]");
  });

  it("does not erase ordinary discussion that merely mentions these words", () => {
    const input = "We discussed the token budget and the password policy; no credentials were shared.";
    expect(redactHindsightText(input)).toBe(input);
  });
});
