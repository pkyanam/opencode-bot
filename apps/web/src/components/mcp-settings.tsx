import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import { api, type McpAuthMethod, type McpServer } from "../api";

const statusLabel = (server: McpServer) => {
  const status = server.status?.status ?? "unknown";
  if (status === "needs_auth") return "Login required";
  if (status === "failed") return "Unavailable";
  return status.replaceAll("_", " ");
};

function callbackValue(value: string): { code?: string; callbackUrl?: string } {
  const input = value.trim();
  if (!input) throw new Error("Paste the one-time callback URL or authorization code first.");
  if (!/^https?:\/\//i.test(input)) return { code: input };
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("That callback URL is not valid."); }
  const query = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.search.slice(1));
  const error = query.get("error");
  if (error) throw new Error(`The service denied login: ${error}.`);
  const code = query.get("code");
  if (!code) throw new Error("That callback URL has no authorization code.");
  return { callbackUrl: input };
}

export function McpSettings({ onSaved, onOpenComputer }: { onSaved?: () => void; onOpenComputer?: (url: string) => void }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [integrations, setIntegrations] = useState<Array<{ id: string; methods?: McpAuthMethod[] }>>([]);
  const [auth, setAuth] = useState<{ server: string; integrationID: string; methodID: string; attemptID?: string; url?: string; instructions?: string }>();
  const [methodPicker, setMethodPicker] = useState<{ server: string; integrationID: string; methods: McpAuthMethod[] }>();
  const [code, setCode] = useState("");
  const statusPoll = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.mcp.list();
      setServers(result.servers ?? []);
      setIntegrations(result.integrations ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load MCP services");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (server: string, operation: () => Promise<unknown>, message: string): Promise<boolean> => {
    setBusy(server);
    setError("");
    setNotice("");
    try {
      await operation();
      setNotice(message);
      await load();
      onSaved?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "MCP operation failed");
      return false;
    } finally {
      setBusy("");
    }
  };
  const startAuth = async (server: McpServer, selectedMethodID?: string) => {
    const integrationID = server.integrationID;
    const methods = integrations.find((item) => item.id === integrationID)?.methods?.filter((method) => /oauth/i.test(method.type ?? "")) ?? [];
    if (!integrationID || !methods.length) {
      setError("This service did not expose a supported login method. Use Native OpenCode → /mcps.");
      return;
    }
    if (methods.length > 1 && !selectedMethodID) { setMethodPicker({ server: server.name, integrationID, methods }); return; }
    if (methods.length > 1 && methodPicker?.server === server.name) { setMethodPicker(undefined); }
    const methodID = selectedMethodID ?? methods[0].id;
    setBusy(server.name); setError(""); setNotice("");
    try {
      const result = await api.mcp.authStart({ integrationID, methodID });
      const attempt = result.attempt;
      if (!attempt?.attemptID) throw new Error("The service did not return a login attempt.");
      setAuth({ server: server.name, integrationID, methodID, attemptID: attempt.attemptID, url: attempt.url, instructions: attempt.instructions });
      setNotice("Open the login link below, or sign in using your Computer. Then check its status here.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start service login"); }
    finally { setBusy(""); }
  };
  const completeAuth = async () => {
    if (!auth?.attemptID) return;
    let value: { code?: string; callbackUrl?: string };
    try { value = callbackValue(code); } catch (e) { setError(e instanceof Error ? e.message : "Enter the callback URL or one-time code."); return; }
    const completed = await run(auth.server, () => api.mcp.authComplete({ integrationID: auth.integrationID, attemptID: auth.attemptID!, ...value }), "Service login completed.");
    if (completed) { setAuth(undefined); setCode(""); }
  };
  const checkAuth = async () => {
    if (!auth?.attemptID) return;
    if (statusPoll.current) return;
    statusPoll.current = true;
    try {
      const result = await api.mcp.authStatus({ integrationID: auth.integrationID, attemptID: auth.attemptID });
      const statusValue = result.status;
      const status = typeof statusValue === "object" && statusValue !== null ? String((statusValue as Record<string, unknown>).status ?? "pending") : String(statusValue ?? result.state ?? "pending");
      setNotice(`Login status: ${status}.`);
      if (/^(completed?|connected|success|succeeded)$/i.test(status)) { setAuth(undefined); await load(); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check service login"); }
    finally { statusPoll.current = false; }
  };
  const cancelAuth = async () => {
    if (!auth?.attemptID) { setAuth(undefined); return; }
    try {
      await api.mcp.authCancel({ integrationID: auth.integrationID, attemptID: auth.attemptID });
      setAuth(undefined); setCode(""); setNotice("Service login canceled.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel service login"); }
  };
  useEffect(() => {
    if (!auth?.attemptID) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || statusPoll.current) return;
      statusPoll.current = true;
      try {
        const result = await api.mcp.authStatus({ integrationID: auth.integrationID, attemptID: auth.attemptID! });
        if (cancelled) return;
        const statusValue = result.status;
        const status = typeof statusValue === "object" && statusValue !== null ? String((statusValue as Record<string, unknown>).status ?? "pending") : String(statusValue ?? result.state ?? "pending");
        if (/^(completed?|connected|success|succeeded)$/i.test(status)) {
          setNotice("Service login completed.");
          setAuth(undefined); setCode("");
          await load();
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not check service login");
      } finally { statusPoll.current = false; }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [auth?.attemptID, auth?.integrationID, load]);

  return (
    <section className="mcp-settings" aria-label="MCP services">
      <div className="settings-section-head">
        <div><h3>MCP services</h3><p>Connect OpenCode services and complete sign in when a service requests it.</p></div>
        <button className="icon-btn" aria-label="Refresh MCP services" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      {loading && !servers.length ? <p className="settings-muted"><LoaderCircle size={14} className="spin" /> Loading services…</p> : servers.length ? <div className="mcp-list">
        {servers.map((server) => {
          const state = server.status?.status;
          const isBusy = busy === server.name;
          return <div className="mcp-row" key={server.name}>
            <div><strong>{server.name}</strong><span className={`mcp-status mcp-status-${state}`}>{statusLabel(server)}</span>{server.status && "error" in server.status && <small>{server.status.error}</small>}</div>
            <div className="settings-actions">
              {state === "connected" ? <button className="soft-btn" disabled={isBusy} onClick={() => void run(server.name, () => api.mcp.disconnect(server.name), "MCP service disconnected.")}><Unplug size={13} />Disconnect</button> : state === "needs_auth" ? <button className="primary-btn" disabled={isBusy} onClick={() => void startAuth(server)}>{isBusy && <LoaderCircle size={13} className="spin" />}Sign in</button> : <button className="primary-btn" disabled={isBusy} onClick={() => void run(server.name, () => api.mcp.connect(server.name), "MCP service connection started.")}>{isBusy && <LoaderCircle size={13} className="spin" />}Connect</button>}
            </div>
            {methodPicker?.server === server.name && <div className="mcp-method-picker"><label className="field-label" htmlFor={`mcp-method-${server.name}`}>Login method</label><select id={`mcp-method-${server.name}`} className="settings-input" value={methodPicker.methods[0]?.id ?? ""} onChange={(event) => setMethodPicker({ ...methodPicker, methods: [methodPicker.methods.find((method) => method.id === event.target.value)!, ...methodPicker.methods.filter((method) => method.id !== event.target.value)] })}>{methodPicker.methods.map((method) => <option key={method.id} value={method.id}>{method.label ?? method.id}</option>)}</select><button className="primary-btn" onClick={() => void startAuth(server, methodPicker.methods[0]?.id)}>Continue</button></div>}
          </div>;
        })}
      </div> : <p className="settings-muted">No MCP services are configured.</p>}
      {auth && <div className="mcp-auth-panel">
        <strong>Authorize {auth.server}</strong>
        {auth.instructions && <p>{auth.instructions}</p>}
        {auth.url && <div className="mcp-auth-links"><a href={auth.url} target="_blank" rel="noreferrer">Open authorization link ↗</a>{onOpenComputer && <button className="primary-btn" onClick={() => onOpenComputer(auth.url!)}>Preferred: Sign in on Computer</button>}</div>}
        <label className="field-label" htmlFor="mcp-callback">Callback completion</label>
        <p>After authorization, paste the full callback URL here, or enter the one-time code. This is not an API token.</p>
        <input id="mcp-callback" className="settings-input" aria-label="OAuth callback URL or code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="https://localhost/callback?code=… or one-time code" />
        <div className="settings-actions"><button className="soft-btn" onClick={() => void checkAuth()}>Check status</button><button className="primary-btn" onClick={() => void completeAuth()} disabled={!auth.attemptID}>Complete login</button><button className="soft-btn" onClick={() => void cancelAuth()}>Cancel</button></div>
      </div>}
      <p className="settings-muted">Changing MCP settings requires no active run. Login opens through the OpenCode service flow; this page never stores service credentials. Add or remove services from Native OpenCode when needed.</p>
    </section>
  );
}
