/**
 * Redact credential-shaped values before conversation text enters durable
 * memory. This is intentionally conservative and bounded; it is a defense in
 * depth measure, not a proof that arbitrary secrets cannot be present.
 */
export function redactHindsightText(input: unknown): string {
  let value = String(input ?? "");
  // Private keys must be removed before any line-oriented credential rules.
  value = value.replace(
    /-----BEGIN [^-\r\n]{1,100}-----[\s\S]*?-----END [^-\r\n]{1,100}-----/gi,
    "[redacted private key]",
  );
  // Authorization headers, including JSON's quoted-key form.
  value = value.replace(
    /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi,
    "Bearer [redacted]",
  );
  value = value.replace(
    /(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*(?:["']?))(?:bearer|basic|token)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1[redacted authorization]",
  );
  // Quoted structured values: "apiKey": "...", 'password'='...'.
  value = value.replace(
    /((?:["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|passwd|secret|token)["']?)\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}\]]+))/gi,
    (_match, prefix, doubleQuoted, singleQuoted) => `${prefix}${doubleQuoted !== undefined ? '"[redacted]"' : singleQuoted !== undefined ? "'[redacted]'" : "[redacted]"}`,
  );
  // Common provider key families when copied without a field label.
  value = value.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|rk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xai-[A-Za-z0-9_-]{16,}|np_[A-Za-z0-9_-]{16,})\b/g,
    "[redacted key]",
  );
  return value;
}
