import {
  createContext,
  useContext,
  useEffect,
  useMemo,
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
  useEffect(() => {
    let alive = true;
    void readConnection().then((connection) => {
      if (!alive || !connection) return;
      setBaseUrl(connection.baseUrl);
      setCachedToken(connection.token);
      setConnected(true);
      void api(connection.baseUrl).state().then((next) => {
        if (alive) { setState(next); setError(""); }
      }).catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setConnected(false);
        setError(e instanceof Error ? e.message : "Could not reach the workspace.");
      });
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => onAuthInvalidated(() => {
    setConnected(false);
    setState(null);
  }), []);
  async function refresh() {
    try {
      setError("");
      setState(await api(baseUrl).state());
      setConnected(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setConnected(false);
      setError(
        e instanceof Error ? e.message : "Could not reach the workspace.",
      );
    }
  }
  async function pairing(url: string, secret: string, name: string) {
    const result = await api(url).redeem(secret, name);
    await saveConnection({ baseUrl: url.trim().replace(/\/$/, ""), token: result.deviceToken });
    setCachedToken(result.deviceToken);
    setBaseUrl(url.trim().replace(/\/$/, ""));
    setConnected(true);
    setState(await api(url).state());
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
      pairing,
      disconnect,
      error,
    }),
    [baseUrl, state, connected, error],
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
