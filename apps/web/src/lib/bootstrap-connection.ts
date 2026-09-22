/** The installer passes the owner token in a fragment, never an HTTP query. */
export function consumeConnectionFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  storage: Pick<Storage, 'setItem'>,
): void {
  const prefix = ['#connect=', '#token='].find(value => location.hash.startsWith(value));
  if (!prefix) return;
  const token = location.hash.slice(prefix.length);
  // Remove even malformed credentials before the app requests any resources.
  history.replaceState(null, '', location.pathname + location.search);
  if (/^(?:[A-Za-z0-9_-]{43}|[a-fA-F0-9]{64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(token)) storage.setItem('opencode-bot-app-token', token);
}
