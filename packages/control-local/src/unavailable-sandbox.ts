/** Deliberately loud replacement used by the local bundle. */
export function getSandbox(): never {
  throw new Error("Cloudflare Sandbox is unavailable in control-local; configure COMPUTER_PROVIDER");
}
export class Sandbox {
  constructor() { throw new Error("Cloudflare Sandbox is unavailable in control-local; configure COMPUTER_PROVIDER"); }
}
