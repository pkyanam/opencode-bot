/** Binary tool results belong in authenticated downloads, not polling JSON. */
export function clientPayload(value: unknown): any {
  if (typeof value === 'string') return value.replace(/data:[a-z0-9.+/-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=\r\n]+/gi, '[inline binary omitted]');
  if (Array.isArray(value)) return value.map(clientPayload);
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  const binary = item.type === 'image' || item.type === 'file' || item.type === 'audio' || item.type === 'blob';
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
    binary && ['data', 'base64', 'bytes'].includes(key) ? '' : clientPayload(child),
  ]));
}
