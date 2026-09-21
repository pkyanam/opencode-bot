import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
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
  const connectionGeneration = useRef(0);
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
    connectionGeneration.current += 1;
    setConnected(false);
    setState(null);
  }), []);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current || !baseUrl) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    const generation = connectionGeneration.current;
    const requestBaseUrl = baseUrl;
    try {
      setError("");
      const next = await api(requestBaseUrl).state();
      if (generation === connectionGeneration.current && requestBaseUrl === baseUrl) {
        setState(next);
        setConnected(true);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setConnected(false);
      setError(
        e instanceof Error ? e.message : "Could not reach the workspace.",
      );
    } finally { refreshInFlight.current = false; setRefreshing(false); }
  }, [baseUrl]);
  useEffect(() => {
    if (!connected || !baseUrl) return;
    let active = AppState.currentState === "active";
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = active ? setInterval(() => void refresh(), 5_000) : undefined;
    };
    const subscription = AppState.addEventListener("change", (next) => {
      active = next === "active";
      if (active) void refresh();
      schedule();
    });
    schedule();
    return () => { subscription.remove(); if (timer) clearInterval(timer); };
  }, [connected, baseUrl, refresh]);
  async function pairing(url: string, secret: string, name: string) {
    const result = await api(url).redeem(secret, name);
    const nextBaseUrl = url.trim().replace(/\/$/, "");
    await saveConnection({ baseUrl: nextBaseUrl, token: result.deviceToken });
    connectionGeneration.current += 1;
    setCachedToken(result.deviceToken);
    setBaseUrl(nextBaseUrl);
    setConnected(true);
    try { setState(await api(nextBaseUrl).state()); }
    catch (error) { setConnected(false); throw error; }
  }
  async function disconnect() {
    connectionGeneration.current += 1;
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
