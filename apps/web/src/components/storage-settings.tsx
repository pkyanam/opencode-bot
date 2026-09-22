import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { api, type StoragePolicy, type StorageSummary } from "../api";

const bytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
};
const date = (value?: string) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never";
const BUDGET_PRESETS = [0.25, 0.5, 1, 2, 5, 10, 20];

export function StorageSettings() {
  const [data, setData] = useState<StorageSummary>();
  const [policy, setPolicy] = useState<StoragePolicy>();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const next = await api.storage.get(); setData(next); setPolicy(next.policy); setSelected([]); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load storage usage"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const savePolicy = async () => {
    if (!policy) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api.storage.updatePolicy(policy); setData(next); setPolicy(next.policy); setNotice("Storage policy saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save storage policy"); }
    finally { setBusy(false); }
  };
  const cleanup = async () => {
    if (!selected.length || !window.confirm(`Delete ${selected.length} selected unprotected checkpoint${selected.length === 1 ? "" : "s"}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try { const next = await api.storage.cleanup(selected); setData(next); setPolicy(next.policy); setSelected([]); setNotice("Selected backups deleted."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete selected backups"); }
    finally { setBusy(false); }
  };
  const candidates = data?.objects.filter((item) => item.category === "checkpoint" && !item.protected) ?? [];
  const visibleCandidates = candidates.slice(0, 500);
  const budgetGiB = policy ? policy.budgetBytes / 1024 ** 3 : 2;
  const budgetPreset = BUDGET_PRESETS.includes(Number(budgetGiB.toFixed(2))) ? String(Number(budgetGiB.toFixed(2))) : "custom";
  const protectedCount = data?.objects.filter((item) => item.category === "checkpoint" && item.protected).length ?? 0;
  const setNumber = (key: "intervalMinutes" | "keepLatest" | "budgetBytes", value: number) => setPolicy((current) => current ? { ...current, [key]: Number.isFinite(value) ? value : 0 } : current);
  return <section className="storage-settings" aria-label="Storage">
    <div className="settings-section-head"><div><h3>Storage</h3><p>Measured deployment R2 storage for this workspace.</p></div><button className="icon-btn" aria-label="Refresh storage usage" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /></button></div>
    <p className="settings-muted">The account-wide R2 allowance includes 10 GB-month free across deployments. Containers require Workers Paid ($5/month) plus compute; memory and disk are charged while a container is awake, including idle time. This R2 meter is not a deployment cost estimate. See <a href="https://developers.cloudflare.com/r2/pricing/" target="_blank" rel="noreferrer">R2 pricing ↗</a> and <a href="https://developers.cloudflare.com/containers/platform/pricing/" target="_blank" rel="noreferrer">Containers pricing ↗</a>.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status">{notice}</p>}
    {loading && !data ? <p className="settings-muted"><LoaderCircle size={14} className="spin" /> Measuring storage…</p> : data && <>
      <div className="storage-facts"><div className="setting-fact"><span>Total</span><strong>{bytes(data.totals.bytes)}</strong></div><div className="setting-fact"><span>Checkpoints</span><strong>{bytes(data.totals.checkpointBytes)}</strong></div><div className="setting-fact"><span>Artifacts and other</span><strong>{bytes(data.totals.otherBytes)}</strong></div><div className="setting-fact"><span>Objects</span><strong>{data.totals.objects}</strong></div></div>
      <div className="storage-policy"><h4>Automatic checkpoints</h4><label className="checkbox-row"><input type="checkbox" checked={policy?.automatic ?? false} onChange={(event) => setPolicy((current) => current ? { ...current, automatic: event.target.checked } : current)} /> Create a checkpoint after the Computer is idle</label><div className="storage-policy-fields"><label className="field-label">After idle (minutes)<input className="settings-input" type="number" min="15" max="1440" step="15" value={policy?.intervalMinutes ?? 60} onChange={(event) => setNumber("intervalMinutes", Number(event.target.value))} /></label><label className="field-label">Keep latest<input className="settings-input" type="number" min="1" max="20" step="1" value={policy?.keepLatest ?? 2} onChange={(event) => setNumber("keepLatest", Number(event.target.value))} /></label><label className="field-label">Budget (GiB)<select className="settings-input" value={budgetPreset} onChange={(event) => { const value = event.target.value; if (value !== "custom") setNumber("budgetBytes", Number(value) * 1024 ** 3); }}><option value="custom">Custom ({budgetGiB.toFixed(2)} GiB)</option>{BUDGET_PRESETS.map((value) => <option key={value} value={value}>{value} GiB</option>)}</select></label></div><button className="primary-btn" disabled={busy || !policy} onClick={() => void savePolicy()}>Save policy</button><p className="settings-muted">Defaults are after 60 minutes idle, keep 2, with a 2 GiB budget. Protected backups count toward keep and budget but are never deleted. Last automatic checkpoint: {date(data.lastAutomaticCheckpointAt)}.</p></div>
      <div className="storage-cleanup"><div className="settings-section-head"><div><h4>Discard old backups</h4><p>Only unprotected checkpoints can be selected. Protected objects stay available for recovery ({protectedCount} listed).</p></div><button className="danger-btn" disabled={busy || !selected.length} onClick={() => void cleanup()}><Trash2 size={14} /> Delete selected</button></div>{data.lastError && <p className="inline-error" role="alert">Automatic checkpoint error: {data.lastError}</p>}{data.truncated && <p className="settings-muted">The object list is truncated; totals include the measured deployment response.</p>}{candidates.length ? <div className="storage-objects">{visibleCandidates.map((item) => <label className="storage-object" key={item.key}><input type="checkbox" checked={selected.includes(item.key)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.key] : current.filter((key) => key !== item.key))} /><span><strong>{item.key}</strong><small>{bytes(item.size)} · uploaded {date(item.uploaded)}</small></span></label>)}</div> : <p className="settings-muted">No unprotected checkpoint backups are available to discard.</p>}{candidates.length > visibleCandidates.length && <p className="settings-muted">Showing the first 500 unprotected checkpoints. Refresh after cleanup to review more.</p>}</div>
      <p className="settings-muted">To remove workspace files, use Workspace → Files. Storage cleanup only removes the selected backup objects.</p>
    </>}
  </section>;
}
