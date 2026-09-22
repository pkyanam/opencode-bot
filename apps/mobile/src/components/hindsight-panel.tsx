import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Brain, RefreshCw, Search } from "lucide-react-native";
import { api } from "../api";
import { colors, styles } from "../ui";
import { Markdown } from "../markdown";
import type { Bot, HindsightEngineStatus, HindsightMentalModel, HindsightObservation, HindsightResponse } from "../types";

type Props = { baseUrl: string; bots: Bot[] };
const budgets = ["low", "mid", "high"] as const;

export function HindsightPanel({ baseUrl, bots }: Props) {
  const [engine, setEngine] = useState<HindsightEngineStatus | null>(null);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState<(typeof budgets)[number]>("mid");
  const [result, setResult] = useState<HindsightResponse | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [syncQueued, setSyncQueued] = useState(false);
  const detailsRequest = useRef(0);
  const operationRequest = useRef(0);
  const [memoryTab, setMemoryTab] = useState<"observations" | "models">("observations");
  const [observations, setObservations] = useState<HindsightObservation[]>([]);
  const [models, setModels] = useState<HindsightMentalModel[]>([]);
  const [modelName, setModelName] = useState("");
  const [modelQuery, setModelQuery] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await api(baseUrl).hindsightEngine();
      setEngine(next);
      if (next.status === "ready") setSyncQueued(false);
      if (!configDirty) {
        setUrl(next.settings.url ?? "");
        setEnabled(next.enabled);
        setAutoCapture(next.settings.autoCapture);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load Hindsight status."); }
  }, [baseUrl, configDirty]);
  useEffect(() => { if (baseUrl) void load(); }, [baseUrl, load]);
  useEffect(() => {
    if (!baseUrl) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [baseUrl, load]);
  useEffect(() => { if (!botId && bots[0]) setBotId(bots[0].id); }, [botId, bots]);
  const loadDetails = useCallback(async () => {
    if (!botId) { setObservations([]); setModels([]); return; }
    const requestId = ++detailsRequest.current;
    try {
      const [nextObservations, nextModels] = await Promise.all([api(baseUrl).hindsightObservations(botId), api(baseUrl).hindsightMentalModels(botId)]);
      if (requestId !== detailsRequest.current) return;
      setObservations(nextObservations); setModels(nextModels);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load Hindsight details."); }
  }, [baseUrl, botId]);
  useEffect(() => { if (baseUrl) void loadDetails(); }, [baseUrl, loadDetails]);
  useEffect(() => {
    if (!baseUrl || !botId) return;
    const timer = setInterval(() => void loadDetails(), 30_000);
    return () => clearInterval(timer);
  }, [baseUrl, botId, loadDetails]);
  useEffect(() => {
    detailsRequest.current++;
    operationRequest.current++;
    setResult(null);
    setObservations([]);
    setModels([]);
    if (baseUrl && botId) void loadDetails();
  }, [baseUrl, botId, loadDetails]);

  async function save() {
    setBusy(true); setError("");
    try {
      const next = await api(baseUrl).configureHindsight({ url: url.trim(), apiKey: apiKey.trim() || undefined, enabled, autoCapture });
      setEngine(next); setApiKey(""); setConfigDirty(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save Hindsight settings."); }
    finally { setBusy(false); }
  }
  async function sync() {
    setBusy(true); setError("");
    try {
      const response = await api(baseUrl).syncHindsight();
      setSyncQueued(Boolean(response.queued));
      if (response.status || response.pending || response.error) {
        setEngine((current) => current ? { ...current, ...(response.status ? { status: response.status } : {}), ...(response.pending !== undefined ? { pending: response.pending } : {}), ...(response.error ? { error: response.error } : {}) } : current);
      }
      void load();
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not sync Hindsight."); }
    finally { setBusy(false); }
  }
  async function run(kind: "recall" | "reflect") {
    if (!botId || !query.trim()) return;
    const requestId = ++operationRequest.current;
    setBusy(true); setError(""); setResult(null); setShowEvidence(false);
    try {
      const next = await (kind === "recall" ? api(baseUrl).hindsightRecall({ botId, query: query.trim(), budget }) : api(baseUrl).hindsightReflect({ botId, query: query.trim(), budget }));
      if (requestId === operationRequest.current) setResult(next);
    }
    catch (e) { setError(e instanceof Error ? e.message : `Could not ${kind} memory.`); }
    finally { setBusy(false); }
  }
  async function createModel() {
    if (!botId || !modelName.trim() || !modelQuery.trim()) return;
    setBusy(true); setError("");
    try { await api(baseUrl).createHindsightMentalModel({ botId, name: modelName.trim(), query: modelQuery.trim() }); setModelName(""); setModelQuery(""); await loadDetails(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create mental model."); }
    finally { setBusy(false); }
  }
  async function refreshModel(model: HindsightMentalModel) {
    if (!botId) return;
    setBusy(true); setError("");
    try { await api(baseUrl).refreshHindsightMentalModel(model.id, botId); await loadDetails(); setTimeout(() => void loadDetails(), 2000); setTimeout(() => void loadDetails(), 5000); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not refresh mental model."); }
    finally { setBusy(false); }
  }
  function deleteModel(model: HindsightMentalModel) {
    if (!botId) return;
    Alert.alert("Delete mental model?", model.name || "This model will be removed.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: async () => { setBusy(true); setError(""); try { await api(baseUrl).deleteHindsightMentalModel(model.id, botId); await loadDetails(); } catch (e) { setError(e instanceof Error ? e.message : "Could not delete mental model."); } finally { setBusy(false); } } }]);
  }
  const status = engine?.status ?? "unavailable";
  const statusLabel = engine ? `${status}${engine.configured ? "" : " · not configured"}` : "Checking…";
  return <View style={local.wrap}>
    <View style={local.titleRow}><View style={{ flex: 1 }}><Text style={local.title}>Hindsight</Text><Text style={styles.subtitle}>Long-term recall and reflection for your bots.</Text></View><Pressable accessibilityLabel="Refresh Hindsight status" onPress={() => void load()} hitSlop={10}><RefreshCw color={colors.muted} size={19} /></Pressable></View>
      <View style={styles.card}>
      <View style={local.statusRow}><Text style={[local.status, status === "ready" ? local.readyText : status === "starting" ? local.startingText : status === "disabled" ? local.disabledText : local.unavailableText]}>{statusLabel}</Text>{engine?.pending ? <ActivityIndicator color={colors.muted} size="small" /> : null}</View>
      {engine?.error ? <Text style={styles.error}>{engine.error}</Text> : null}
      <Text style={styles.subtitle}>Capabilities: {engine?.capabilities?.join(" · ") || "Unavailable"}</Text>
    </View>
    <View style={styles.card}>
      <Text style={local.section}>Connection</Text>
      <Text style={styles.label}>External Hindsight URL (optional)</Text><TextInput value={url} onChangeText={(value) => { setUrl(value); setConfigDirty(true); }} placeholder="Blank uses built-in Cloudflare Hindsight" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="url" style={styles.input} />
      <Text style={styles.label}>API key (optional)</Text><TextInput value={apiKey} onChangeText={setApiKey} placeholder="Leave blank to keep current key" placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" style={styles.input} />
      <View style={local.switchRow}><View style={{ flex: 1 }}><Text style={local.switchTitle}>Enable Hindsight</Text><Text style={styles.subtitle}>Use it for memory operations.</Text></View><Switch value={enabled} onValueChange={(value) => { setEnabled(value); setConfigDirty(true); }} trackColor={{ false: colors.line, true: colors.muted }} thumbColor={colors.text} /></View>
      <View style={local.switchRow}><View style={{ flex: 1 }}><Text style={local.switchTitle}>Automatic capture</Text><Text style={styles.subtitle}>Let the workspace retain useful conversation context.</Text></View><Switch value={autoCapture} onValueChange={(value) => { setAutoCapture(value); setConfigDirty(true); }} trackColor={{ false: colors.line, true: colors.muted }} thumbColor={colors.text} /></View>
      <Pressable disabled={busy} onPress={() => void save()} style={[styles.button, { marginTop: 8, opacity: busy ? .5 : 1 }]}><Text style={styles.buttonText}>{busy ? "Saving…" : "Save settings"}</Text></Pressable>
      <Pressable disabled={busy || !enabled} onPress={() => void sync()} style={[styles.ghost, { marginTop: 10, opacity: busy || !enabled ? .5 : 1 }]}><Text style={styles.ghostText}>{busy ? "Working…" : syncQueued ? "Sync queued" : engine?.failed ? "Retry sync" : "Sync connection"}</Text></Pressable>
    </View>
    <View style={styles.card}>
      <Text style={local.section}>Explore memory</Text><Text style={styles.subtitle}>Choose a bot to keep this request scoped to its memory.</Text>
      <View style={local.choices}>{bots.map((bot) => <Pressable key={bot.id} onPress={() => setBotId(bot.id)} style={[local.choice, botId === bot.id && local.selected]}><Text style={{ color: botId === bot.id ? colors.text : colors.muted, fontSize: 13 }}>{bot.name}</Text></Pressable>)}</View>
      {!bots.length ? <Text style={styles.subtitle}>Add a bot before using recall or reflect.</Text> : null}
      <TextInput value={query} onChangeText={setQuery} placeholder="What should I remember?" placeholderTextColor={colors.muted} multiline style={[styles.input, local.query]} textAlignVertical="top" />
      <View style={local.choices}>{budgets.map((value) => <Pressable key={value} onPress={() => setBudget(value)} style={[local.choice, budget === value && local.selected]}><Text style={{ color: budget === value ? colors.text : colors.muted, fontSize: 13 }}>{value} budget</Text></Pressable>)}</View>
      <View style={local.actions}><Pressable disabled={busy || !botId || !query.trim()} onPress={() => void run("recall")} style={[styles.ghost, local.action, { opacity: busy || !botId || !query.trim() ? .5 : 1 }]}><Search color={colors.text} size={16} /><Text style={styles.ghostText}>Recall</Text></Pressable><Pressable disabled={busy || !botId || !query.trim()} onPress={() => void run("reflect")} style={[styles.button, local.action, { opacity: busy || !botId || !query.trim() ? .5 : 1 }]}><Brain color="#191817" size={16} /><Text style={styles.buttonText}>Reflect</Text></Pressable></View>
      {result?.text ? <View style={local.result}><Markdown value={previewMarkdown(result.text)} compact />{result.sources?.length ? <Text style={styles.subtitle}>{result.sources.length} source{result.sources.length === 1 ? "" : "s"}</Text> : null}{result.based_on ? <><Pressable onPress={() => setShowEvidence((value) => !value)}><Text style={styles.subtitle}>{showEvidence ? "Hide" : "Show"} evidence</Text></Pressable>{showEvidence ? <View style={local.evidence}><Text style={styles.subtitle}>{(result.based_on.memories?.length ?? 0) + (result.based_on.mental_models?.length ?? 0)} memory source{(result.based_on.memories?.length ?? 0) + (result.based_on.mental_models?.length ?? 0) === 1 ? "" : "s"}</Text>{[...(result.based_on.memories ?? []), ...(result.based_on.mental_models ?? [])].slice(0, 5).map((item, index) => <Text key={String(item.id ?? index)} style={styles.subtitle} numberOfLines={2}>• {previewMarkdown(item.text ?? readable(item))}</Text>)}{result.based_on.directives?.length ? <Text style={styles.subtitle}>Directives: {result.based_on.directives.slice(0, 3).join(" · ")}</Text> : null}</View> : null}</> : null}</View> : null}
    </View>
    <View style={styles.card}>
      <View style={local.tabRow}><Pressable onPress={() => setMemoryTab("observations")} style={[local.tab, memoryTab === "observations" && local.tabSelected]}><Text style={local.tabText}>Observations ({observations.length})</Text></Pressable><Pressable onPress={() => setMemoryTab("models")} style={[local.tab, memoryTab === "models" && local.tabSelected]}><Text style={local.tabText}>Mental models ({models.length})</Text></Pressable></View>
      {memoryTab === "observations" ? <View style={local.list}>{observations.slice(0, 8).map((observation, index) => <View style={local.listItem} key={String(observation.id ?? index)}><Markdown value={previewMarkdown(typeof observation.text === "string" ? observation.text : typeof observation.content === "string" ? observation.content : readable(observation))} compact /></View>)}{!observations.length ? <Text style={styles.subtitle}>No observations for this bot yet.</Text> : observations.length > 8 ? <Text style={styles.subtitle}>Showing 8 of {observations.length} observations.</Text> : null}</View> : <View style={local.list}><TextInput value={modelName} onChangeText={setModelName} placeholder="Model name" placeholderTextColor={colors.muted} style={styles.input} /><TextInput value={modelQuery} onChangeText={setModelQuery} placeholder="What question should this model answer?" placeholderTextColor={colors.muted} style={styles.input} /><Pressable disabled={busy || !botId || !modelName.trim() || !modelQuery.trim()} onPress={() => void createModel()} style={[styles.button, { opacity: busy || !botId || !modelName.trim() || !modelQuery.trim() ? .5 : 1 }]}><Text style={styles.buttonText}>{busy ? "Creating…" : "Create mental model"}</Text></Pressable>{models.slice(0, 8).map((model) => <View style={local.listItem} key={model.id}><View style={local.modelHeader}><Text style={local.switchTitle} numberOfLines={1}>{model.name || "Untitled model"}</Text><View style={local.modelActions}><Pressable accessibilityLabel={`Refresh ${model.name || "mental model"}`} onPress={() => void refreshModel(model)} hitSlop={8}><RefreshCw color={colors.muted} size={15} /></Pressable><Pressable accessibilityLabel={`Delete ${model.name || "mental model"}`} onPress={() => deleteModel(model)} hitSlop={8}><Text style={local.deleteText}>Delete</Text></Pressable></View></View>{model.local_status === "failed" ? <Text style={styles.error}>Generation failed: {model.local_error || "Hindsight could not refresh this model."}</Text> : model.local_status === "pending" || model.local_status === "creating" ? <Text style={styles.subtitle}>Generation in progress…</Text> : null}{model.content ? <Markdown value={previewMarkdown(model.content)} compact /> : !model.local_status || model.local_status === "ready" ? <Text style={styles.subtitle}>No generated content yet.</Text> : null}{model.source_query || model.sourceQuery ? <Text style={styles.subtitle} numberOfLines={2}>Question: {model.source_query || model.sourceQuery}</Text> : null}</View>)}{!models.length ? <Text style={styles.subtitle}>No mental models yet. Create one from a question above.</Text> : null}</View>}
    </View>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>;
}

function readable(value: Record<string, unknown>): string {
  return Object.entries(value).filter(([key]) => key !== "id").map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join(" · ").slice(0, 800);
}
function previewMarkdown(value: string): string {
  const normalized = value.replace(/\r/g, "").trim();
  return normalized.length > 1400 ? `${normalized.slice(0, 1400).trimEnd()}…` : normalized;
}

const local = StyleSheet.create({ wrap: { gap: 12, paddingBottom: 24 }, titleRow: { flexDirection: "row", alignItems: "center", gap: 12 }, title: { color: colors.text, fontSize: 20, fontWeight: "600", marginBottom: 5 }, section: { color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: 12 }, statusRow: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }, readyText: { color: "#8da88b" }, startingText: { color: "#c6a66a" }, unavailableText: { color: colors.danger }, disabledText: { color: colors.muted }, status: { color: colors.text, fontWeight: "600", flex: 1 }, switchRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }, switchTitle: { color: colors.text, fontSize: 14, marginBottom: 2 }, choices: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 10 }, choice: { borderColor: colors.line, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 }, selected: { borderColor: colors.muted, backgroundColor: colors.panel2 }, query: { minHeight: 84 }, actions: { flexDirection: "row", gap: 10 }, action: { flex: 1, flexDirection: "row", gap: 8 }, result: { borderTopColor: colors.line, borderTopWidth: 1, marginTop: 16, paddingTop: 15, gap: 10 }, resultText: { color: colors.text, fontSize: 15, lineHeight: 22 }, evidence: { gap: 6, paddingTop: 4 }, tabRow: { flexDirection: "row", borderBottomColor: colors.line, borderBottomWidth: 1, marginBottom: 12 }, tab: { flex: 1, paddingVertical: 10, alignItems: "center", borderBottomWidth: 2, borderBottomColor: "transparent" }, tabSelected: { borderBottomColor: colors.text }, tabText: { color: colors.text, fontSize: 12, fontWeight: "600" }, list: { gap: 10 }, listItem: { borderTopColor: colors.line, borderTopWidth: 1, paddingTop: 11, gap: 7 }, modelHeader: { flexDirection: "row", alignItems: "center", gap: 8 }, modelActions: { flexDirection: "row", alignItems: "center", gap: 13, marginLeft: "auto" }, deleteText: { color: colors.danger, fontSize: 12 } });
