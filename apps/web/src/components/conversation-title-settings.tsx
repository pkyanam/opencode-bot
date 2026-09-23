import { useEffect, useState } from "react";
import { request, type CatalogModel } from "../api";
import { ModelPicker } from "./model-picker";
import { Button } from "./ui/button";

export function ConversationTitleSettings({ models }: { models: CatalogModel[] }) {
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void request<{ model: string }>("/api/settings/utility-model").then((value) => setModel(value.model ?? "")).catch((error) => setNotice(error instanceof Error ? error.message : "Could not load utility settings")); }, []);
  async function save() {
    setBusy(true); setNotice("");
    try { await request<{ model: string }>("/api/settings/utility-model", { method: "PATCH", body: JSON.stringify({ model }) }); setNotice("Saved"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not save"); }
    finally { setBusy(false); }
  }
  return <section className="settings-section">
    <div className="settings-section-head"><h3>Conversation titles</h3></div>
    <p>Titles are generated from your first message. Choose a utility model, or use each bot’s model on its computer.</p>
    <div className="field-label">Utility model</div>
    <ModelPicker placeholder="Use each bot’s model" models={models} value={model} onChange={setModel} />
    <Button variant="ghost" onClick={() => setModel("")} disabled={!model}>{model ? "Use each bot’s model instead" : "Using each bot’s model"}</Button>
    <div className="settings-actions"><Button variant="outline" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save title settings"}</Button>{notice ? <span className="settings-muted" role="status">{notice}</span> : null}</div>
  </section>;
}
