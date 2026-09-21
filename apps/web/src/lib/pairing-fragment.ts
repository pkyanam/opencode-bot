/** Consume pairing secrets before loading the workspace or third-party resources. */
export function consumePairingFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
): string | undefined {
  if (!location.hash.startsWith('#pair=')) return;
  const value = location.hash.slice(6);
  history.replaceState(null, '', location.pathname + location.search);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '';
}
