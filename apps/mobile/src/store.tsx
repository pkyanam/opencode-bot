import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, onAuthInvalidated, setCachedToken } from "./api";
import { clearConnection, readConnection, saveConnection } from "./storage";
import type { State } from "./types";
type Store = {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  state: State | null;
  refresh: () => Promise<void>;
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  pairing: (baseUrl: string, secret: string, name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  error: string;
};
const StoreContext = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    void readConnection().then((connection) => {
      if (!alive || !connection) { if (alive) setLoading(false); return; }
      setBaseUrl(connection.baseUrl);
      setCachedToken(connection.token);
      setConnected(true);
      void api(connection.baseUrl).state().then((next) => {
        if (alive) { setState(next); setError(""); }
      }).catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setConnected(false);
        setError(e instanceof Error ? e.message : "Could not reach the workspace.");
      }).finally(() => { if (alive) setLoading(false); });
    }).catch((e) => {
      // SecureStore can reject (for example after an OS restore). Leave the
      // signed-out screen usable instead of keeping its spinner forever.
      if (alive) { setError(e instanceof Error ? e.message : "Could not load saved connection."); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => onAuthInvalidated(() => {
    setConnected(false);
    setState(null);
  }), []);
  async function refresh() {
    if (refreshInFlight.current || !baseUrl) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      setError("");
      setState(await api(baseUrl).state());
      setConnected(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setConnected(false);
      setError(
        e instanceof Error ? e.message : "Could not reach the workspace.",
      );
    } finally { refreshInFlight.current = false; setRefreshing(false); }
  }
  async function pairing(url: string, secret: string, name: string) {
    const result = await api(url).redeem(secret, name);
    await saveConnection({ baseUrl: url.trim().replace(/\/$/, ""), token: result.deviceToken });
    setCachedToken(result.deviceToken);
    setBaseUrl(url.trim().replace(/\/$/, ""));
    setConnected(true);
    try { setState(await api(url).state()); }
    catch (error) { setConnected(false); throw error; }
  }
  async function disconnect() {
    await clearConnection();
    setCachedToken(null);
    setState(null);
    setConnected(false);
  }
  const value = useMemo(
    () => ({
      baseUrl,
      setBaseUrl,
      state,
      refresh,
      connected,
      loading,
      refreshing,
      pairing,
      disconnect,
      error,
    }),
    [baseUrl, state, connected, loading, refreshing, error],
  );
  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}
export const useStore = () => {
  const context = useContext(StoreContext);
  if (!context) throw new Error("StoreProvider missing");
  return context;
};
