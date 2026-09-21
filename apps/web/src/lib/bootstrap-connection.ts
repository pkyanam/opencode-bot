/** The installer passes the owner token in a fragment, never an HTTP query. */
export function consumeConnectionFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  storage: Pick<Storage, 'setItem'>,
): void {
  if (!location.hash.startsWith('#connect=')) return;
  const token = location.hash.slice('#connect='.length);
  // Remove even malformed credentials before the app requests any resources.
  history.replaceState(null, '', location.pathname + location.search);
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) storage.setItem('opencode-bot-app-token', token);
}
