import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  Edit3,
  FileText,
  History,
  LoaderCircle,
  Pin,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, type Bot, type MemoryItem } from "../api";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { HindsightPanel } from "./hindsight-panel";
import { MarkdownContent } from "./markdown-content";

type Props = { bots: Bot[]; bot?: Bot; onClose: () => void };
type Visibility = "private" | "shared" | "workspace";

const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "";

export function MemoryRegistry({ bots, bot, onClose }: Props) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [filterBot, setFilterBot] = useState(bot?.id ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [history, setHistory] = useState<MemoryItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [engineMode, setEngineMode] = useState<"ask" | "settings">("settings");
  const [engineOpen, setEngineOpen] = useState(false);
  const requestId = useRef(0);

  const load = async (append = false) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const offset = append ? items.length : 0;
      const result = await api.memoryRegistry({
        botId: filterBot || undefined,
        q: query || undefined,
        offset,
        limit: 100,
      });
      if (id !== requestId.current) return;
      setItems((current) =>
        append
          ? [
              ...current,
              ...result.filter(
                (item) => !current.some((entry) => entry.id === item.id),
              ),
            ]
          : result,
      );
      setHasMore(result.length === 100);
      setError("");
    } catch (e) {
      if (id === requestId.current)
        setError(
          e instanceof Error ? e.message : "Could not load memory registry",
        );
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 260);
    return () => {
      window.clearTimeout(timer);
      requestId.current++;
    };
  }, [filterBot, query]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [filterBot, query, items.length]);
  const botName = (id?: string | null) =>
    id
      ? (bots.find((item) => item.id === id)?.name ?? "Archived bot")
      : "Workspace";
  const visibleItems = useMemo(() => items, [items]);
  const exportJson = async () => {
    try {
      const all: MemoryItem[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await api.memoryRegistry({
          botId: filterBot || undefined,
          q: query || undefined,
          offset,
          limit: 200,
        });
        all.push(...page);
        if (page.length < 200) break;
      }
      const blob = new Blob([JSON.stringify(all, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "workspace-memory.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export memory");
    }
  };
  const remove = async (item: MemoryItem) => {
    if (!window.confirm("Delete this memory?")) return;
    try {
      await api.removeMemory(item.id, item.revision);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete memory");
    }
  };
  const togglePin = async (item: MemoryItem) => {
    try {
      const saved = await api.updateMemory(item.id, {
        pinned: !item.pinned,
        revision: item.revision,
      });
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? saved : entry)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update memory");
    }
  };
  const showHistory = async (item: MemoryItem) => {
    try {
      setHistory(await api.memoryHistory(item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="modal memory-registry"
        aria-describedby="memory-description"
      >
        <div className="modal-head">
          <div>
            <div className="modal-kicker">WORKSPACE</div>
            <DialogTitle>Memories</DialogTitle>
          </div>
          <div className="memory-header-actions">
            <button className="icon-btn" onClick={() => { setEngineMode("settings"); setEngineOpen(true); }} aria-label="Memory settings" title="Memory settings"><Settings2 size={17} /></button>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        <p className="modal-copy" id="memory-description">
          Useful context your bots can remember and share.
        </p>
        <div className="memory-toolbar">
          <label className="memory-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories…"
              aria-label="Search memories"
            />
          </label>
          <select
            className="memory-select"
            aria-label="Memories available to"
            value={filterBot}
            onChange={(e) => setFilterBot(e.target.value)}
          >
            <option value="">All bots</option>
            {bots.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="soft-btn" onClick={exportJson}>
            <Download size={14} /> Export
          </button>
          <button className="soft-btn" onClick={() => { setEngineMode("ask"); setEngineOpen(true); }}>Ask memories</button>
          <button
            className="primary-btn"
            disabled={!bots.length}
            title={
              !bots.length ? "Create a bot before adding memory" : undefined
            }
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            <Plus size={14} /> New memory
          </button>
        </div>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            {error}
            <button className="retry-inline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        {loading && !items.length ? (
          <div className="memory-empty">
            <LoaderCircle size={17} className="spin" /> Loading memories…
          </div>
        ) : !visibleItems.length ? (
          <div className="memory-empty">
            <FileText size={18} /> No memories match this view.
          </div>
        ) : (
          <div className="memory-list">
            {visibleItems.map((item) => (
              <article
                className={`memory-item registry-item ${item.pinned ? "is-pinned" : ""}`}
                key={item.id}
              >
                <div className="registry-main">
                  <div className="registry-meta">
                    <span className="memory-owner">{botName(item.botId)}</span>
                    <span
                      className={`memory-badge memory-scope-${item.visibility ?? "private"}`}
                    >
                      {item.visibility ?? "private"}
                    </span>
                    {item.kind && (
                      <span className="memory-kind">{item.kind}</span>
                    )}
                  </div>
                  <button className="memory-title-button" onClick={() => setExpandedId((current) => current === item.id ? null : item.id)} aria-expanded={expandedId === item.id}>
                    <h3>{item.title || "Untitled memory"}</h3><ChevronDown size={15} aria-hidden="true" />
                  </button>
                  <MarkdownContent className={`memory-content-markdown ${expandedId === item.id ? "is-expanded" : ""}`}>{item.content}</MarkdownContent>
                  <div className="registry-foot">
                    <span>{date(item.updatedAt ?? item.createdAt)}</span>
                    {item.sourceThreadId && (
                      <span>
                        From thread {item.sourceThreadId.slice(0, 8)}…
                      </span>
                    )}
                    {item.visibility === "shared" &&
                    item.sharedBotIds?.length ? (
                      <span>
                        Shared with {item.sharedBotIds.map(botName).join(", ")}
                      </span>
                    ) : null}
                    {item.tags?.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                </div>
                {expandedId === item.id && <div className="registry-actions" aria-label="Memory actions">
                  <button
                    className="soft-btn"
                    onClick={() => void togglePin(item)}
                    aria-label={item.pinned ? "Unpin memory" : "Pin memory"}
                  >
                    <Pin size={14} fill={item.pinned ? "currentColor" : "none"} /> {item.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    className="soft-btn"
                    onClick={() => {
                      setEditing(item);
                      setShowForm(true);
                    }}
                    aria-label="Edit memory"
                  >
                    <Edit3 size={14} /> Edit & share
                  </button>
                  <button
                    className="soft-btn"
                    onClick={() => void showHistory(item)}
                    aria-label="View history"
                  >
                    <History size={14} /> History
                  </button>
                  <button
                    className="soft-btn danger"
                    onClick={() => void remove(item)}
                    aria-label="Delete memory"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>}
              </article>
            ))}
          </div>
        )}
        {hasMore && !loading && (
          <button
            className="soft-btn memory-load-more"
            onClick={() => void load(true)}
          >
            Load more memories
          </button>
        )}
        {showForm && (
          <MemoryForm
            bots={bots}
            initial={editing}
            defaultBotId={filterBot || bot?.id}
            onClose={() => setShowForm(false)}
            onSaved={(saved) => {
              setItems((current) =>
                editing
                  ? current.map((entry) =>
                      entry.id === saved.id ? saved : entry,
                    )
                  : [saved, ...current],
              );
              setShowForm(false);
            }}
          />
        )}
        {history && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setHistory(null);
            }}
          >
            <DialogContent
              className="memory-history"
              aria-describedby={undefined}
            >
              <div className="modal-head">
                <DialogTitle>Memory history</DialogTitle>
                <button
                  className="icon-btn"
                  onClick={() => setHistory(null)}
                  aria-label="Close history"
                >
                  <X size={16} />
                </button>
              </div>
              {history.length ? (
                history.map((version, index) => (
                  <div className="history-row" key={`${version.id}-${index}`}>
                    <strong>
                      Revision {version.revision ?? history.length - index}
                    </strong>
                    <span>{date(version.updatedAt ?? version.createdAt)}</span>
                    <MarkdownContent className="memory-history-content">{version.content}</MarkdownContent>
                  </div>
                ))
              ) : (
                <div className="memory-empty">No previous versions.</div>
              )}
            </DialogContent>
          </Dialog>
        )}
        {engineOpen && <Dialog open onOpenChange={(open) => setEngineOpen(open)}>
          <DialogContent className="memory-engine-dialog" aria-describedby={undefined}>
            <div className="modal-head"><div><div className="modal-kicker">{engineMode === "ask" ? "ASK MEMORIES" : "MEMORY SETTINGS"}</div><DialogTitle>{engineMode === "ask" ? "Ask your bots" : "Memory settings"}</DialogTitle></div><button className="icon-btn" onClick={() => setEngineOpen(false)} aria-label="Close"><X size={16} /></button></div>
            <HindsightPanel bots={bots} mode={engineMode} />
          </DialogContent>
        </Dialog>}
      </DialogContent>
    </Dialog>
  );
}

function MemoryForm({
  bots,
  initial,
  defaultBotId,
  onClose,
  onSaved,
}: {
  bots: Bot[];
  initial: MemoryItem | null;
  defaultBotId?: string;
  onClose: () => void;
  onSaved: (item: MemoryItem) => void;
}) {
  const [botId, setBotId] = useState(
    initial ? (initial.botId ?? "") : (defaultBotId ?? bots[0]?.id ?? ""),
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "fact");
  const [tags, setTags] = useState(initial?.tags?.join(", ") ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    initial?.visibility ?? "private",
  );
  const [sharedBotIds, setSharedBotIds] = useState(initial?.sharedBotIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (
      (!initial && !botId) ||
      !content.trim() ||
      (visibility === "shared" && !sharedBotIds.length)
    )
      return;
    setSaving(true);
    try {
      const payload = {
        title: title.trim() || undefined,
        content: content.trim(),
        kind: kind || undefined,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        visibility,
        sharedBotIds: visibility === "shared" ? sharedBotIds : [],
        pinned: initial?.pinned ?? false,
      };
      const item = initial
        ? await api.updateMemory(initial.id, {
            ...payload,
            revision: initial.revision,
          })
        : await api.createMemory({ ...payload, botId });
      onSaved(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save memory");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="memory-form" aria-describedby={undefined}>
        <div className="modal-head">
          <DialogTitle>{initial ? "Edit memory" : "New memory"}</DialogTitle>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {error && (
          <div className="inline-error">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
        <label>
          Owner bot
          <select
            className="memory-select"
            disabled={Boolean(initial)}
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
          >
            <option value="">
              {initial ? "Archived bot" : "Choose a bot"}
            </option>
            {bots.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input
            className="text-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short description"
          />
        </label>
        <label>
          Memory
          <textarea
            className="text-area"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            maxLength={16000}
            placeholder="A durable fact, preference, decision, or lesson…"
          />
        </label>
        <div className="memory-form-grid">
          <label>
            Kind
            <select
              className="memory-select"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {[
                "fact",
                "preference",
                "decision",
                "lesson",
                "procedure",
                "note",
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tags
            <input
              className="text-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="comma, separated"
            />
          </label>
        </div>
        <label>
          Sharing
          <select
            className="memory-select"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">Private to owner</option>
            <option value="shared">Shared with selected bots</option>
            <option value="workspace">Entire workspace</option>
          </select>
        </label>
        {visibility === "shared" && (
          <div className="shared-bots">
            <small>Share with bots (select at least one)</small>
            {bots
              .filter((item) => item.id !== botId)
              .map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={sharedBotIds.includes(item.id)}
                    onChange={(e) =>
                      setSharedBotIds((current) =>
                        e.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>{item.name}</span>
                </label>
              ))}
          </div>
        )}
        <div className="memory-form-actions">
          <button className="soft-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-btn"
            disabled={
              (!initial && !botId) ||
              !content.trim() ||
              saving ||
              (visibility === "shared" && !sharedBotIds.length)
            }
            onClick={() => void save()}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            <Check size={14} /> Save memory
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
