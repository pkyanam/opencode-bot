import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Database,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  api,
  type Bot,
  type HindsightEngine,
  type HindsightMentalModel,
  type HindsightObservation,
  type HindsightResponse,
} from "../api";
import { MarkdownContent } from "./markdown-content";

type Props = { bots: Bot[]; mode?: "all" | "ask" | "settings" };
type Budget = "low" | "mid" | "high";

const statusLabel: Record<HindsightEngine["status"], string> = {
  ready: "Ready",
  starting: "Starting",
  unavailable: "Unavailable",
  disabled: "Disabled",
};

export function HindsightPanel({ bots, mode = "all" }: Props) {
  const askMode = mode === "ask";
  const settingsMode = mode === "settings";
  const [engine, setEngine] = useState<HindsightEngine | null>(null);
  const [error, setError] = useState("");
  const [engineError, setEngineError] = useState("");
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [externalOpen, setExternalOpen] = useState(false);
  const [autoCapture, setAutoCapture] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState<Budget>("mid");
  const [exploring, setExploring] = useState<"recall" | "reflect" | null>(null);
  const [result, setResult] = useState<HindsightResponse | null>(null);
  const [observations, setObservations] = useState<HindsightObservation[]>([]);
  const [models, setModels] = useState<HindsightMentalModel[]>([]);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [queuedModelId, setQueuedModelId] = useState<string | null>(null);
  const [queuedModelTimestamp, setQueuedModelTimestamp] = useState<
    string | null
  >(null);
  const engineRequest = useRef(0);
  const insightsRequest = useRef(0);
  const exploreRequest = useRef(0);
  const activeBotId = useRef(botId);
  const settingsDirty = useRef(false);
  const modelRequest = useRef(0);

  const loadEngine = async (hydrate = false) => {
    const request = ++engineRequest.current;
    setLoading(true);
    try {
      const value = await api.hindsightEngine();
      if (request !== engineRequest.current) return;
      setEngine(value);
      if (hydrate && !settingsDirty.current) {
        setUrl(value.settings?.url ?? "");
        setExternalOpen(Boolean(value.settings?.url));
        setAutoCapture(Boolean(value.settings?.autoCapture));
        setEnabled(Boolean(value.enabled));
      }
      setEngineError("");
    } catch (e) {
      setEngineError(
        e instanceof Error ? e.message : "Could not load Hindsight status",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadEngine(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadEngine();
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!botId && bots[0]) setBotId(bots[0].id);
  }, [bots, botId]);
  const save = async () => {
    setSaving(true);
    try {
      const value = await api.configureHindsight({
        url: url.trim(),
        apiKey: apiKey.trim() || undefined,
        enabled,
        autoCapture,
      });
      setEngine(value);
      setApiKey("");
      settingsDirty.current = false;
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save Hindsight settings",
      );
    } finally {
      setSaving(false);
    }
  };
  const sync = async () => {
    setSyncing(true);
    try {
      setEngine(await api.syncHindsight());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue memory sync");
    } finally {
      setSyncing(false);
    }
  };
  const explore = async (kind: "recall" | "reflect") => {
    if (!botId || !query.trim()) return;
    const currentBotId = botId;
    const request = ++exploreRequest.current;
    setExploring(kind);
    setResult(null);
    try {
      const response =
        kind === "recall"
          ? await api.recallHindsight({ botId, query: query.trim(), budget })
          : await api.reflectHindsight({ botId, query: query.trim(), budget });
      if (
        request !== exploreRequest.current ||
        currentBotId !== activeBotId.current
      )
        return;
      setResult(response);
      setError("");
    } catch (e) {
      if (
        request === exploreRequest.current &&
        currentBotId === activeBotId.current
      )
        setError(`Saved memories are safe. Retrieval is unavailable: ${e instanceof Error ? e.message : `Could not ${kind} memory`}`);
    } finally {
      if (request === exploreRequest.current) setExploring(null);
    }
  };
  const isReady = engine?.status === "ready" && engine.enabled;
  const loadInsights = async (showLoading = true) => {
    if (!botId) return;
    const currentBotId = botId;
    const request = ++insightsRequest.current;
    if (showLoading) setInsightsLoading(true);
    try {
      const [nextObservations, nextModels] = await Promise.all([
        api.hindsightObservations(botId),
        api.hindsightMentalModels(botId),
      ]);
      if (
        request !== insightsRequest.current ||
        currentBotId !== activeBotId.current
      )
        return;
      setObservations(nextObservations);
      setModels(nextModels);
      setError("");
      if (
        queuedModelId &&
        nextModels.some(
          (model) =>
            model.id === queuedModelId &&
            Boolean(model.last_refreshed_at) &&
            (queuedModelTimestamp === null ||
              model.last_refreshed_at !== queuedModelTimestamp),
        )
      ) {
        setQueuedModelId(null);
        setQueuedModelTimestamp(null);
      }
    } catch (e) {
      if (
        request === insightsRequest.current &&
        currentBotId === activeBotId.current
      )
        setError(
          `Saved memories are safe. Retrieval is unavailable: ${e instanceof Error ? e.message : "Could not load Hindsight observations"}`,
        );
    } finally {
      if (showLoading && request === insightsRequest.current)
        setInsightsLoading(false);
    }
  };
  const createModel = async () => {
    if (!botId || !modelName.trim() || !modelQuery.trim()) return;
    const currentBotId = botId;
    const request = ++modelRequest.current;
    setModelBusy(true);
    try {
      const model = await api.createHindsightMentalModel({
        botId,
        name: modelName.trim(),
        query: modelQuery.trim(),
      });
      if (
        request !== modelRequest.current ||
        currentBotId !== activeBotId.current
      )
        return;
      setModels((current) => [model, ...current]);
      setModelName("");
      setModelQuery("");
      setError("");
    } catch (e) {
      if (
        request === modelRequest.current &&
        currentBotId === activeBotId.current
      )
        setError(
          e instanceof Error ? e.message : "Could not create mental model",
        );
    } finally {
      if (request === modelRequest.current) setModelBusy(false);
    }
  };
  const refreshModel = async (model: HindsightMentalModel) => {
    const currentBotId = botId;
    const request = ++modelRequest.current;
    setModelBusy(true);
    const baselineTimestamp = model.last_refreshed_at ?? null;
    try {
      await api.refreshHindsightMentalModel(model.id, botId);
      if (
        request !== modelRequest.current ||
        currentBotId !== activeBotId.current
      )
        return;
      setQueuedModelId(model.id);
      setQueuedModelTimestamp(baselineTimestamp);
      setError("");
      void loadInsights(false);
    } catch (e) {
      if (
        request === modelRequest.current &&
        currentBotId === activeBotId.current
      )
        setError(
          e instanceof Error ? e.message : "Could not refresh mental model",
        );
    } finally {
      if (request === modelRequest.current) setModelBusy(false);
    }
  };
  const deleteModel = async (model: HindsightMentalModel) => {
    if (!window.confirm(`Delete “${model.name}”?`)) return;
    const currentBotId = botId;
    const request = ++modelRequest.current;
    setModelBusy(true);
    try {
      await api.deleteHindsightMentalModel(model.id, botId);
      if (
        request !== modelRequest.current ||
        currentBotId !== activeBotId.current
      )
        return;
      setModels((current) => current.filter((entry) => entry.id !== model.id));
      if (queuedModelId === model.id) {
        setQueuedModelId(null);
        setQueuedModelTimestamp(null);
      }
      setError("");
    } catch (e) {
      if (
        request === modelRequest.current &&
        currentBotId === activeBotId.current
      )
        setError(
          e instanceof Error ? e.message : "Could not delete mental model",
        );
    } finally {
      if (request === modelRequest.current) setModelBusy(false);
    }
  };
  useEffect(() => {
    if (!insightsOpen || !botId || !isReady) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadInsights(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [insightsOpen, botId, isReady]);
  useEffect(() => {
    activeBotId.current = botId;
    insightsRequest.current++;
    exploreRequest.current++;
    modelRequest.current++;
    setExploring(null);
    setModelBusy(false);
    setQueuedModelId(null);
    setQueuedModelTimestamp(null);
    setObservations([]);
    setModels([]);
    setResult(null);
    setInsightsOpen(false);
  }, [botId]);
  return (
    <section className="hindsight-panel" aria-label={askMode ? "Ask memories" : "Hindsight"}>
      {!askMode && <div className="hindsight-heading">
        <div>
          <div className="memory-section-kicker">
            <Database size={13} /> MEMORY ENGINE
          </div>
          <h2 id="hindsight-heading">Hindsight</h2>
          <p>Long-term recall and reflection for your bots.</p>
        </div>
        <div
          className={`hindsight-status hindsight-status-${engine?.status ?? "unavailable"}`}
          aria-live="polite"
        >
          {loading ? "Checking…" : engine?.status === "starting" && (engine.pending ?? 0) > 0 ? "Indexing memories…" : statusLabel[engine?.status ?? "unavailable"]}
        </div>
      </div>}
      {askMode && <p className="hindsight-muted">Ask a question using the memories available to the selected bot.</p>}
      {askMode && engine?.status !== "ready" && <p role="status">{engine?.status === "starting" && (engine.pending ?? 0) > 0 ? "New memories are being indexed for search." : `Memory search is ${statusLabel[engine?.status ?? "starting"].toLowerCase()}.`} Your saved memories are still available.</p>}
      {(error || engineError) && (
        <div className="hindsight-error">
          <AlertCircle size={14} /> <span>{error || engineError}</span>
          <button className="retry-inline" onClick={() => void loadEngine()}>
            Retry
          </button>
        </div>
      )}
      {engine?.error && (
        <div className="hindsight-error">
          <AlertCircle size={14} /> <span>{engine.error}</span>
        </div>
      )}
      {!askMode && <div className="hindsight-settings">
        <details
          className="hindsight-advanced"
          open={externalOpen}
          onToggle={(event) =>
            setExternalOpen((event.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary>External engine settings</summary>
          <div className="hindsight-advanced-body">
            <label>
              Engine URL
              <input
                className="text-input"
                value={url}
                onChange={(e) => {
                  settingsDirty.current = true;
                  setUrl(e.target.value);
                }}
                placeholder="Built-in Cloudflare Hindsight"
              />
            </label>
            <label>
              API key{" "}
              <span className="hindsight-write-only">
                optional · write-only
              </span>
              <input
                className="text-input"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  settingsDirty.current = true;
                  setApiKey(e.target.value);
                }}
                placeholder={
                  engine?.configured
                    ? "Saved key · enter to replace"
                    : "Only needed for an external engine"
                }
                autoComplete="new-password"
              />
            </label>
          </div>
        </details>
        <div className="hindsight-setting-row">
          <label className="hindsight-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                settingsDirty.current = true;
                setEnabled(e.target.checked);
              }}
            />
            <span />
            Enable Hindsight
          </label>
          <label className="hindsight-toggle">
            <input
              type="checkbox"
              checked={autoCapture}
              onChange={(e) => {
                settingsDirty.current = true;
                setAutoCapture(e.target.checked);
              }}
              disabled={!enabled}
            />
            <span />
            Auto-capture new memories
          </label>
        </div>
        <div className="hindsight-model">
          Model{" "}
          <strong>{engine?.settings?.model || "Managed by Hindsight"}</strong>
        </div>
        <div className="hindsight-actions">
          <button
            className="primary-btn"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving && <LoaderCircle size={13} className="spin" />}
            <Check size={13} /> Save settings
          </button>
          <button
            className="soft-btn"
            onClick={() => void sync()}
            disabled={syncing || !engine || engine.status === "disabled"}
          >
            {syncing && <LoaderCircle size={13} className="spin" />}
            <RefreshCw size={13} /> Sync memories
          </button>
        </div>
      </div>}
      {!settingsMode && <div className="hindsight-explore">
        {!askMode && <div className="memory-section-kicker">
          <Search size={13} /> EXPLORE MEMORY
        </div>}
        <div className="hindsight-explore-controls">
          <select
            className="memory-select"
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            aria-label="Bot for exploration"
          >
            <option value="">Choose a bot</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <details className="hindsight-budget-details">
            <summary>Advanced</summary>
            <select className="memory-select hindsight-budget" value={budget} onChange={(e) => setBudget(e.target.value as Budget)} aria-label="Exploration budget">
              <option value="low">Low budget</option>
              <option value="mid">Balanced</option>
              <option value="high">High budget</option>
            </select>
          </details>
        </div>
        <textarea
          className="text-area hindsight-query"
          rows={2}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask what this bot knows, or ask it to connect the dots…"
        />
        <div className="hindsight-actions">
          <button
            className="soft-btn"
            disabled={!isReady || !botId || !query.trim() || Boolean(exploring)}
            onClick={() => void explore("recall")}
          >
            {exploring === "recall" && (
              <LoaderCircle size={13} className="spin" />
            )}{" "}
            {askMode ? "Find matching memories" : "Recall"}
          </button>
          <button
            className="soft-btn"
            disabled={!isReady || !botId || !query.trim() || Boolean(exploring)}
            onClick={() => void explore("reflect")}
          >
            {exploring === "reflect" && (
              <LoaderCircle size={13} className="spin" />
            )}{" "}
            {askMode ? "Ask" : "Reflect"}
          </button>
        </div>
        {result && (
          <div className="hindsight-result">
            {!result.text && !result.results?.length && <p>No matching memories were found. Try a different question or save a memory first.</p>}
            {result.text && (
              <MarkdownContent className="hindsight-result-markdown">
                {result.text}
              </MarkdownContent>
            )}
            {result.results?.map((item, i) => (
              <div className="hindsight-result-row" key={i}>
                <MarkdownContent>
                  {item.content || item.text || JSON.stringify(item)}
                </MarkdownContent>
                {typeof item.score === "number" && (
                  <small>{Math.round(item.score * 100)}%</small>
                )}
              </div>
            ))}
            {result.sources?.length ? (
              <small className="hindsight-sources">
                Sources:{" "}
                {result.sources.map((source, i) => (
                  <span key={i}>{source.title || source.url || "Source"}</span>
                ))}
              </small>
            ) : null}
            {result.based_on && (
              <details className="hindsight-evidence">
                <summary>Evidence</summary>
                <div className="hindsight-evidence-body">
                  {result.based_on.memories?.map((memory, i) => (
                    <div
                      className="hindsight-evidence-item"
                      key={memory.id ?? i}
                    >
                      <small>{memory.type || "Memory"}</small>
                      <MarkdownContent>
                        {memory.text || "Untitled memory"}
                      </MarkdownContent>
                    </div>
                  ))}
                  {result.based_on.mental_models?.map((model, i) => (
                    <div
                      className="hindsight-evidence-item"
                      key={model.id ?? i}
                    >
                      <small>Mental model</small>
                      <MarkdownContent>
                        {model.text || "Untitled model"}
                      </MarkdownContent>
                    </div>
                  ))}
                  {!result.based_on.memories?.length &&
                    !result.based_on.mental_models?.length && (
                      <span className="hindsight-muted">
                        No supporting evidence returned.
                      </span>
                    )}
                </div>
              </details>
            )}
          </div>
        )}
        {botId && (
          <details
            className="hindsight-insights"
            open={insightsOpen}
            onToggle={(event) => {
              const open = (event.currentTarget as HTMLDetailsElement).open;
              setInsightsOpen(open);
              if (open && isReady && !observations.length && !models.length)
                void loadInsights();
            }}
          >
            <summary>Observations and mental models</summary>
            {insightsLoading ? (
              <div className="hindsight-muted">
                <LoaderCircle size={13} className="spin" /> Loading insights…
              </div>
            ) : (
              <div className="hindsight-insights-body">
                <div className="hindsight-insights-head">
                  <strong>Observations</strong>
                  <button
                    className="retry-inline"
                    disabled={!isReady}
                    onClick={() => void loadInsights()}
                  >
                    Refresh
                  </button>
                </div>
                {observations.length ? (
                  observations.slice(0, 8).map((item, index) => (
                    <div
                      className="hindsight-observation"
                      key={item.id ?? index}
                    >
                      <MarkdownContent>
                        {item.text || item.content || "Untitled observation"}
                      </MarkdownContent>
                    </div>
                  ))
                ) : (
                  <div className="hindsight-muted">No observations yet.</div>
                )}
                <div className="hindsight-insights-head">
                  <strong>Mental models</strong>
                </div>
                {models.length ? (
                  models.slice(0, 8).map((model) => (
                    <article className="hindsight-model-card" key={model.id}>
                      <div>
                        <strong>{model.name}</strong>
                        {model.local_status === "failed" && (
                          <div className="hindsight-model-error">
                            Generation failed: {model.local_error || "Hindsight could not refresh this model."}
                          </div>
                        )}
                        {model.local_status === "pending" && (
                          <div className="hindsight-model-pending"><LoaderCircle size={12} className="spin" /> Generation in progress…</div>
                        )}
                        {model.content ? (
                          <MarkdownContent>{model.content}</MarkdownContent>
                        ) : (
                          <p>
                            {queuedModelId === model.id
                              ? "Refresh queued…"
                              : "No generated content yet."}
                          </p>
                        )}
                        {(model.source_query || model.sourceQuery) && (
                          <small>
                            Question: {model.source_query || model.sourceQuery}
                          </small>
                        )}
                      </div>
                      <div className="hindsight-model-actions">
                        <button
                          className="retry-inline"
                          disabled={modelBusy || !isReady}
                          onClick={() => void refreshModel(model)}
                        >
                          {queuedModelId === model.id ? "Queued" : "Refresh"}
                        </button>
                        <button
                          className="retry-inline hindsight-delete"
                          disabled={modelBusy}
                          onClick={() => void deleteModel(model)}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="hindsight-muted">No mental models yet.</div>
                )}
                <div className="hindsight-model-create">
                  <input
                    className="text-input"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder="Model name"
                  />
                  <input
                    className="text-input"
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.target.value)}
                    placeholder="Question this model should answer"
                  />
                  <button
                    className="soft-btn"
                    disabled={
                      modelBusy || !isReady || !modelName.trim() || !modelQuery.trim()
                    }
                    onClick={() => void createModel()}
                  >
                    {modelBusy && <LoaderCircle size={13} className="spin" />}{" "}
                    Create model
                  </button>
                </div>
              </div>
            )}
          </details>
        )}
      </div>}
    </section>
  );
}
