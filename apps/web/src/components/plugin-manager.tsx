import { FormEvent, useEffect, useState } from "react";
import { Loader2, Package, Plus, Trash2 } from "lucide-react";
import { isComputerWarmingUpError, request } from "../api";
import { Button } from "./ui/button";

export type NativePlugin = { package: string; removable?:boolean };

/** UI for the runner's native OpenCode plugin route. Installation is always an explicit click. */
export function PluginManager({ catalog = [] }: { catalog?: string[] }) {
  const [plugins, setPlugins] = useState<NativePlugin[]>([]), [packageSpec, setPackageSpec] = useState(""), [busy, setBusy] = useState(false), [removing, setRemoving] = useState<string>(), [error, setError] = useState(""), [message, setMessage] = useState("");
  const load = async () => { try { setPlugins((await request<{ plugins?: NativePlugin[] }>("/api/extensions/plugins")).plugins || []); } catch (e) { setError(isComputerWarmingUpError(e) ? "Your Computer is still starting. Try again when it is ready." : "Could not load installed plugins."); } };
  useEffect(() => { void load(); }, []);
  const install = async (event: FormEvent) => { event.preventDefault(); if (!packageSpec.trim()) return; setBusy(true); setError(""); setMessage(""); try { await request("/api/extensions/plugins", { method: "POST", body: JSON.stringify({ package: packageSpec.trim() }) }); setMessage(`${packageSpec.trim()} was installed.`); setPackageSpec(""); await load(); } catch (e) { setError(isComputerWarmingUpError(e) ? "Your Computer is still starting. Try again when it is ready." : e instanceof Error ? e.message : "Could not install plugin."); } finally { setBusy(false); } };
  const remove = async (value: string) => { setRemoving(value); setError(""); try { await request("/api/extensions/plugins", { method: "DELETE", body: JSON.stringify({ package: value }) }); setMessage(`${value} was removed.`); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Could not remove plugin."); } finally { setRemoving(undefined); } };
  return <section className="extension-results" aria-label="OpenCode plugins">
    <p className="extension-copy">Plugins run inside OpenCode and can access its runtime capabilities. Review the package and version before installing.</p>
    <p className="extension-note"><Package size={13} /> Installing changes the native OpenCode configuration and takes effect when the current runtime is idle.</p>
    {catalog.length > 0 && <div className="extension-sources" aria-label="Plugin catalog">{catalog.map((item) => <button className="extension-repository" type="button" key={item} onClick={() => setPackageSpec(item)}><span>{item}</span><Plus size={14} /></button>)}</div>}
    <form className="extension-add-repository" onSubmit={install}><label htmlFor="native-plugin-package">npm package and exact version</label><div className="extension-add-row"><input id="native-plugin-package" className="text-input" value={packageSpec} onChange={(e) => setPackageSpec(e.target.value)} placeholder="@scope/plugin@1.2.3" autoComplete="off" /><Button type="submit" size="sm" disabled={busy || !packageSpec.trim()}>{busy ? <Loader2 className="extension-spin" size={14} /> : <Plus size={14} />} Install</Button></div></form>
    {plugins.length > 0 && <div className="extension-repository-list">{plugins.map((plugin) => <div className="extension-repository" key={plugin.package}><code>{plugin.package}</code><Button size="sm" variant="ghost" onClick={() => void remove(plugin.package)} disabled={busy || Boolean(removing) || plugin.removable === false}>{removing === plugin.package ? <Loader2 className="extension-spin" size={14} /> : <Trash2 size={14} />} Remove</Button></div>)}</div>}
    {message && <p className="extension-success" role="status">{message}</p>}{error && <p className="extension-error" role="alert">{error}</p>}
  </section>;
}
