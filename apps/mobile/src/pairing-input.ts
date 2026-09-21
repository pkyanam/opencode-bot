/** QR invitations carry both the server and one-time secret. */
export function parsePairingInput(value: string): {
  baseUrl?: string;
  credential: string;
} {
  const input = value.trim();
  if (!input) throw new Error("The invitation is empty.");
  if (!/^https?:\/\//i.test(input)) return { credential: input };
  const url = new URL(input);
  if (url.username || url.password)
    throw new Error("Invalid workspace invitation.");
  const secret = new URLSearchParams(url.hash.slice(1)).get("pair");
  if (!secret?.startsWith("ps_") || !/^ps_[A-Za-z0-9_-]+$/.test(secret))
    throw new Error("This QR code is not a workspace invitation.");
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
    credential: secret,
  };
}
