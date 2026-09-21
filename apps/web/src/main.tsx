import { DeviceConnectionGate } from "./components/device-connection";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ExtensionDiscovery } from "./components/extension-discovery";
import { mergeActivityMessages } from "./lib/transcript";
import {
  mergeDelegationTimeline,
  type Delegation,
} from "./lib/delegation-timeline";
import { SettingsModal } from "./components/settings";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  ArrowUpRight,
  Bot as BotIcon,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Command,
  FileText,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  request,
  CONNECTION_EVENT,
  ApprovalRequest,
  Bot,
  Catalog,
  CatalogAction,
  CatalogAgent,
  CatalogModel,
  ComputerStatus,
  getToken,
  isComputerWarmingUpError,
  MemoryItem,
  Message,
  Attachment,
  Routine,
  Run,
  setToken,
  Skill,
  State,
  Thread,
} from "./api";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { MarkdownContent } from "./components/markdown-content";
import { AttachmentCards, ChatAttachments, uploadFiles } from "./components/chat-attachments";
import { ToolActivity } from "./components/tool-activity";
import { FilesExplorer } from "./components/files-explorer";
import { RunProgress } from "./components/run-progress";
const NativeTerminal = React.lazy(() =>
  import("./components/native-terminal").then((module) => ({
    default: module.NativeTerminal,
  })),
);
import "./styles.css";
import "./workspace-theme.css";

const isActive = (s?: string) =>
  [
    "queued",
    "provisioning",
    "running",
    "waiting_approval",
    "waiting_human",
    "recovering",
    "checkpointing",
    "cancelling",
  ].includes((s ?? "").toLowerCase());
const fmtTime = (d?: string) =>
  d
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(d))
    : "";
const key = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const pendingApproval = (run?: Run): ApprovalRequest | undefined => {
  if (!run) return undefined;
  const raw =
    run.pendingApproval ??
    run.approvalRequest ??
    run.approval ??
    run.approvals?.find(
      (a) =>
        !a.status ||
        ["pending", "requested", "waiting"].includes(a.status.toLowerCase()),
    );
  if (
    !raw ||
    (raw.status &&
      !["pending", "requested", "waiting"].includes(raw.status.toLowerCase()))
  )
    return undefined;
  const payload = raw.payload ?? {};
  return {
    ...payload,
    ...raw,
    requestId: raw.requestId ?? String(payload.requestId ?? payload.id ?? ""),
  } as ApprovalRequest;
};

function DelegationCard({
  item,
  onNavigate,
}: {
  item: Delegation;
  onNavigate: (botId: string, threadId: string) => void;
}) {
  return (
    <details className="delegation-card" key={item.id}>
      <summary>
        <span>
          <ArrowUpRight size={15} /> {item.targetBotName}
        </span>
        <span>{item.status.replaceAll("_", " ")}</span>
      </summary>
      <p>{item.prompt}</p>
      {item.result && (
        <MarkdownContent className="delegation-result">
          {item.result}
        </MarkdownContent>
      )}
      {item.error && <p role="alert">{item.error}</p>}
      <button
        className="soft-btn"
        onClick={() => onNavigate(item.targetBotId, item.targetThreadId)}
      >
        Open {item.targetBotName}’s conversation <ArrowUpRight size={14} />
      </button>
    </details>
  );
}

function App() {
  const [connectionRevision, setConnectionRevision] = useState(0);
  useEffect(() => {
    const changed = () => setConnectionRevision((value) => value + 1);
    window.addEventListener(CONNECTION_EVENT, changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener(CONNECTION_EVENT, changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  const [state, setState] = useState<State>({
    bots: [],
    threads: [],
    runs: [],
  });
  const [selectedThread, setSelectedThread] = useState<string>();
  const [selectedBot, setSelectedBot] = useState<string>();
  const [renaming, setRenaming] = useState<Thread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "thread"; item: Thread }
    | { kind: "bot"; item: Bot }
    | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsUploading, setAttachmentsUploading] = useState(false);
  const draftStore = useRef<Record<string, { prompt: string; attachments: Attachment[] }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBot, setShowBot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const sendInFlight = useRef(false);
  const [editingBot, setEditingBot] = useState<Bot>();
  const [showMemory, setShowMemory] = useState(false);
  const [showRoutines, setShowRoutines] = useState(false);
  const [showComputer, setShowComputer] = useState(false);
  const [connected, setConnected] = useState(Boolean(getToken()));
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [surface, setSurface] = useState<"chat" | "skills" | "files">("chat");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [composerModel, setComposerModel] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({});
  const [catalogError, setCatalogError] = useState("");
  const [catalogWarming, setCatalogWarming] = useState(false);
  const [computerWarming, setComputerWarming] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [liveMessages, setLiveMessages] = useState<Message[]>([]);
  const [threadSessionId, setThreadSessionId] = useState<string>();
  const [delegations, setDelegations] = useState<Delegation[]>([]);

  const refreshInFlight = useRef(false);
  const refresh = async (quiet = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      if (!quiet) setLoading(true);
      const next = await api.state();
      setState(next);
      setError("");
      setConnected(true);
      setSelectedThread((current) => current ?? next.threads[0]?.id);
    } catch (e) {
      setConnected(false);
      if (!quiet)
        setError(e instanceof Error ? e.message : "Could not load workspace");
    } finally {
      refreshInFlight.current = false;
      if (!quiet) setLoading(false);
    }
  };
  useEffect(() => {
    if (!getToken()) {
      setShowSettings(true);
      setConnected(false);
      setLoading(false);
      return;
    }
    refresh();
    api
      .routines()
      .then(setRoutines)
      .catch(() => undefined);
    const loadCatalog = async () => {
      try {
        const value = await api.catalog();
        setCatalog(value);
        setCatalogError("");
        setCatalogWarming(false);
      } catch (e) {
        if (isComputerWarmingUpError(e)) {
          setCatalogWarming(true);
          setCatalogError("");
          return;
        }
        setCatalogWarming(false);
        setCatalogError(
          e instanceof Error ? e.message : "Live catalog unavailable",
        );
      }
    };
    void loadCatalog();
    let cancelled = false;
    let retryTimer: number | undefined;
    const pollReadiness = async () => {
      try {
        const readiness = await api.computerReadiness();
        if (cancelled) return;
        if (readiness.state === "ready") {
          setComputerWarming(false);
          // A catalog request made during startup can fail with 503 (or
          // observe an empty registry). Readiness is the durable transition
          // signal, so refresh once when it becomes ready rather than leaving
          // the initial failed catalog in the UI until a manual refresh.
          void loadCatalog();
          return;
        }
        if (readiness.state === "error") {
          setComputerWarming(false);
          return;
        }
        setComputerWarming(true);
      } catch (e) {
        if (!cancelled && isComputerWarmingUpError(e)) setComputerWarming(true);
      }
      if (!cancelled) retryTimer = window.setTimeout(pollReadiness, 3000);
    };
    void pollReadiness();
    const wake = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener("visibilitychange", wake);
    const id = window.setInterval(wake, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [connectionRevision]);
  useEffect(() => {
    if (!catalogWarming || !getToken()) return;
    const timer = window.setInterval(() => {
      api
        .catalog()
        .then((value) => {
          setCatalog(value);
          setCatalogError("");
          setCatalogWarming(false);
        })
        .catch((e) => {
          if (!isComputerWarmingUpError(e)) {
            setCatalogWarming(false);
            setCatalogError(e instanceof Error ? e.message : "Live catalog unavailable");
          }
        });
    }, 3500);
    return () => window.clearInterval(timer);
  }, [catalogWarming]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (surface === "skills")
      api
        .skills()
        .then(setSkills)
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Could not load skills"),
        );
  }, [surface]);
  const thread =
    state.threads.find(
      (t) =>
        t.id === selectedThread && (!selectedBot || t.botId === selectedBot),
    ) ?? state.threads.find((t) => !selectedBot || t.botId === selectedBot);
  const bot =
    state.bots.find((b) => b.id === (selectedBot ?? thread?.botId)) ??
    state.bots[0];
  const composerKey = `${bot?.id ?? "none"}:${thread?.id ?? "new"}`;
  const activeComposerKey = useRef(composerKey);
  activeComposerKey.current = composerKey;
  const uploadInFlight = useRef(false);
  useEffect(() => {
    const draft = draftStore.current[composerKey];
    setPrompt(draft?.prompt ?? "");
    setAttachments(draft?.attachments ?? []);
  }, [composerKey]);
  const saveDraft = (nextPrompt: string, nextAttachments = attachments) => {
    draftStore.current[composerKey] = { prompt: nextPrompt, attachments: nextAttachments };
  };
  const reportAttachmentError = (message: string) => setError(message);
  const applyAttachmentUpdate = (update: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    const draft = draftStore.current[composerKey] ?? { prompt, attachments };
    const next = typeof update === "function" ? update(draft.attachments) : update;
    draftStore.current[composerKey] = { ...draft, attachments: next };
    if (activeComposerKey.current === composerKey) setAttachments(next);
  };
  const acceptFiles = (files: File[]) => {
    if (uploadInFlight.current) return;
    uploadInFlight.current = true;
    setAttachmentsUploading(true);
    void uploadFiles(files, attachments, applyAttachmentUpdate, reportAttachmentError).finally(() => {
      uploadInFlight.current = false;
      setAttachmentsUploading(false);
    });
  };
  useEffect(() => {
    setComposerModel(bot?.model ?? "");
  }, [bot?.id, bot?.model]);
  const runs = useMemo(
    () => state.runs
      .filter((r) => r.threadId === thread?.id)
      .slice()
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    [state.runs, thread?.id],
  );
  const latestTerminal = runs[runs.length - 1];
  const latest =
    runs
      .filter(
        (run) =>
          isActive(run.status) && (run.status ?? "").toLowerCase() !== "queued",
      )
      .at(-1) ??
    runs.find((run) => (run.status ?? "").toLowerCase() === "queued") ??
    latestTerminal;
  useEffect(() => {
    setLiveMessages([]);
    setThreadSessionId(undefined);
  }, [thread?.id]);
  useEffect(() => {
    if (!thread || thread.nodeId) {
      setLiveMessages([]);
      setThreadSessionId(undefined);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const result = await api.threadMessages(thread.id);
        if (!cancelled) {
          // A just-queued run can briefly expose an empty native transcript.
          // Keep the rendered transcript until the durable message appears.
          if (result.messages?.length) setLiveMessages(result.messages);
          setThreadSessionId(result.sessionId);
        }
      } catch {
        // The regular workspace refresh will surface connection errors.
      } finally {
        inFlight = false;
      }
    };
    void load();
    document.addEventListener("visibilitychange", load);
    const poll = latest && isActive(latest.status)
      ? window.setInterval(() => void load(), 2000)
      : undefined;
    return () => {
      cancelled = true;
      if (poll) window.clearInterval(poll);
      document.removeEventListener("visibilitychange", load);
    };
  }, [thread?.id, thread?.nodeId, latest?.id, latest?.status, terminalOpen]);
  useEffect(() => {
    if (!thread?.id) {
      setDelegations([]);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await request<Delegation[]>(
          `/api/threads/${encodeURIComponent(thread.id)}/delegations`,
        );
        if (!cancelled) setDelegations(next);
      } catch {
        // Keep the last known handoff cards while reconnecting.
      } finally { inFlight = false; }
    };
    void load();
    document.addEventListener("visibilitychange", load);
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [thread?.id]);
  const messages = useMemo(
    () =>
      liveMessages.length
        ? liveMessages
        : (state.messages?.[thread?.id ?? ""] ??
          state.threadMessages?.[thread?.id ?? ""] ??
          liveMessages),
    [state, thread?.id, liveMessages],
  );
  const pendingInputs = useMemo(
    () =>
      (state.pendingMessages ?? [])
        .filter((input) => input.threadId === thread?.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.pendingMessages, thread?.id],
  );
  const pendingRunIds = new Set(pendingInputs.map((input) => input.runId));
  const queuedRunInputs = runs
    .filter((run) => {
      const status = (run.status ?? "").toLowerCase();
      return (
        (status === "queued" || status === "provisioning") &&
        !run.internal &&
        Boolean(run.prompt) &&
        !pendingRunIds.has(run.id)
      );
    })
    .map((run) => ({
      id: `run-${run.id}`,
      threadId: run.threadId,
      runId: run.id,
      content: run.prompt!,
      status: "queued",
      nativeId: undefined,
      createdAt: run.createdAt ?? new Date().toISOString(),
      attachments: run.attachments,
    }));
  const pendingRecords = [...pendingInputs, ...queuedRunInputs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const transcriptMessageIds = new Set(
    messages.map((message) => message.id).filter(Boolean),
  );
  const pendingTranscript = pendingRecords
    .filter((input) => {
      if (input.nativeId && transcriptMessageIds.has(input.nativeId)) return false;
      // Normal queued runs have no nativeId. Once their user message is in the
      // native transcript, match it by content and temporal position.
      return !messages.some(
        (message) =>
          message.role === "user" &&
          message.content === input.content &&
          (!message.createdAt || message.createdAt >= input.createdAt),
      );
    })
    .map(
      (input) =>
        ({
          id: `pending-${input.id}`,
          role: "user",
          content: input.content,
          createdAt: input.createdAt,
          status: input.status,
          attachments: input.attachments,
        }) satisfies Message,
    );
  const fallbackMessages =
    latest?.prompt &&
    !pendingRecords.some((input) => input.content === latest.prompt)
      ? [
          { role: "user", content: latest.prompt, attachments: latest.attachments },
          ...(latest.result
            ? [{ role: "assistant", content: latest.result }]
            : []),
        ]
      : [];
  const baseTranscript = [
    ...(messages.length ? messages : fallbackMessages),
    ...pendingTranscript,
  ];
  const transcript = mergeActivityMessages(baseTranscript, runs);
  const conversation = mergeDelegationTimeline(transcript, delegations);
  const working = latest && isActive(latest.status);
  const latestStatus = (latest?.status ?? "").toLowerCase();
  const botWorking = useMemo(() => {
    if (!bot) return false;
    const botThreadIds = new Set(
      state.threads.filter((item) => item.botId === bot.id).map((item) => item.id),
    );
    return state.runs.some((run) => botThreadIds.has(run.threadId) && isActive(run.status));
  }, [bot, state.runs, state.threads]);
  const nativeSessionLocked = terminalOpen || Boolean(working) || submitting;
  const composerBusy = submitting || attachmentsUploading;
  const chatScroll = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const lastConversation = conversation.at(-1);
  useEffect(() => { followConversation.current = true; }, [thread?.id]);
  useEffect(() => {
    if (!followConversation.current) return;
    const frame = requestAnimationFrame(() => {
      if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [thread?.id, conversation.length, latest?.updatedAt, lastConversation?.kind === "message" ? lastConversation.message.content : lastConversation?.delegation.updatedAt]);
  const terminalSessionId =
    threadSessionId ?? thread?.sessionId ?? thread?.runnerSessionId;

  const syncComposerModel = async () => {
    if (!bot || composerModel === (bot.model ?? "")) return;
    await api.updateBot(bot.id, { model: composerModel });
  };
  const clearSubmittedPrompt = (text: string) => {
    if (activeComposerKey.current === composerKey) {
      setPrompt((current) => (current.trim() === text ? "" : current));
      setAttachments([]);
    }
    saveDraft("", []);
  };
  const submit = async () => {
    const text = prompt.trim();
    if ((!text && !attachments.length) || !bot || sendInFlight.current || attachmentsUploading) return;
    if (attachments.length && text.startsWith("/")) {
      setError("Send attachments with an ordinary message; native slash commands do not accept files.");
      return;
    }
    let submittedDraftKey = composerKey;
    const submittedAttachments = attachments;
    const submittedPrompt = text || "Review the attached files.";
    followConversation.current = true;
    sendInFlight.current = true;
    setSubmitting(true);
    try {
      const targetThread =
        thread ??
        (await api.thread({ botId: bot.id, title: "New conversation" }));
      if (!thread) {
        submittedDraftKey = `${bot.id}:${targetThread.id}`;
        setState(current => ({ ...current, threads: current.threads.some(item => item.id === targetThread.id) ? current.threads : [targetThread, ...current.threads] }));
        if (activeComposerKey.current === composerKey) setSelectedThread(targetThread.id);
      }
      const slash = text.match(/^\/([\w.:-]+)(?:\s+([\s\S]*))?$/);
      if (slash) {
        const native = catalog.commands?.find(
          (command) => command.name === slash[1],
        );
        if (native) {
          clearSubmittedPrompt(text);
          try {
            await syncComposerModel();
            await api.run({
              threadId: targetThread.id,
              prompt: submittedPrompt,
              idempotencyKey: key(),
              commandName: native.name,
              commandText: slash[2] ?? "",
              attachments: submittedAttachments,
            });
            await refresh(true);
          } catch (error) {
            setError(error instanceof Error ? error.message : "Command failed");
            if (activeComposerKey.current === submittedDraftKey) { setPrompt(current => current.trim() ? current : text); setAttachments(submittedAttachments); }
            draftStore.current[submittedDraftKey] = { prompt: text, attachments: submittedAttachments };
          }
          return;
        }
        const action = catalog.actions?.find(
          (action) => action.name === slash[1],
        );
        if (action) {
          if (nativeSessionLocked) {
            setError(
              "Native session actions cannot be queued while a run is active. Send an ordinary message instead.",
            );
            return;
          }
          clearSubmittedPrompt(text);
          if (action.requires?.includes("messageID")) setPaletteOpen(true);
          else await submitNativeAction(action);
          return;
        }
        if (
          [
            "models",
            "agents",
            "new",
            "sessions",
            "skills",
            "files",
            "computer",
            "terminal",
            "help",
          ].includes(slash[1])
        ) {
          setPrompt("");
          performWebAction(slash[1]);
          return;
        }
        setError(
          `/${slash[1]} is not in this workspace’s command catalog. Open Native OpenCode for terminal commands.`,
        );
        return;
      }
      clearSubmittedPrompt(text);
      try {
        await syncComposerModel();
        await api.run({
          threadId: targetThread.id,
          prompt: submittedPrompt,
          idempotencyKey: key(),
          attachments: submittedAttachments,
        });
        await refresh(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start run");
        if (activeComposerKey.current === submittedDraftKey) { setPrompt(current => current.trim() ? current : text); setAttachments(submittedAttachments); }
        draftStore.current[submittedDraftKey] = { prompt: text, attachments: submittedAttachments };
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create a conversation",
      );
    } finally {
      sendInFlight.current = false;
      setSubmitting(false);
    }
  };
  const submitNativeCommand = async (name: string) => {
    if (!thread || nativeSessionLocked) return;
    setPrompt(`/${name} `);
  };
  const submitNativeAction = async (
    action: CatalogAction,
    messageID?: string,
  ) => {
    if (!thread || nativeSessionLocked || !action.name) return;
    try {
      await api.threadAction(thread.id, {
        command: `/${action.name}`,
        messageID,
        sessionAction: {
          name: String(action.action ?? action.name),
          input: messageID ? { messageID } : {},
        },
        idempotencyKey: key(),
      });
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run native action");
    }
  };
  const openBotEditor = (target?: Bot) => {
    setEditingBot(target);
    setShowBot(true);
  };
  const performWebAction = (name: string) => {
    if (name === "models" || name === "agents") openBotEditor(bot);
    else if (name === "new") createThread();
    else if (name === "sessions") setSurface("chat");
    else if (name === "skills") setSurface("skills");
    else if (name === "files") setSurface("files");
    else if (name === "computer") setComputerOpen(true);
    else if (name === "terminal") setTerminalOpen(true);
    else if (name === "help")
      setError(
        "Use the live palette to run native session commands, or choose a workspace tool.",
      );
  };
  const createThread = async () => {
    if (!bot) {
      openBotEditor();
      return;
    }
    try {
      const t = await api.thread({ botId: bot.id, title: "New conversation" });
      setSelectedThread(t.id);
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create thread");
    }
  };
  const requestDeleteThread = (target: Thread) => {
    const targetRun = state.runs.some((run) => run.threadId === target.id && isActive(run.status));
    if (targetRun) {
      setError("This conversation is still working. Stop the run before deleting it.");
      return;
    }
    setDeleteError("");
    setDeleteTarget({ kind: "thread", item: target });
  };
  const requestDeleteBot = (target: Bot) => {
    const targetRun = state.runs.some((run) => {
      const targetThread = state.threads.find((item) => item.id === run.threadId);
      return targetThread?.botId === target.id && isActive(run.status);
    });
    if (targetRun) {
      setError("This bot is still working. Stop its run before deleting it.");
      return;
    }
    setShowBot(false);
    setDeleteError("");
    setDeleteTarget({ kind: "bot", item: target });
  };
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleteError("");
    setDeleting(true);
    try {
      if (deleteTarget.kind === "thread") {
        await api.deleteThread(deleteTarget.item.id);
        setLiveMessages([]);
        setThreadSessionId(undefined);
        setSelectedThread((current) =>
          current === deleteTarget.item.id ? undefined : current,
        );
      } else {
        await api.deleteBot(deleteTarget.item.id);
        setLiveMessages([]);
        setThreadSessionId(undefined);
        setSelectedBot((current) =>
          current === deleteTarget.item.id ? undefined : current,
        );
        setSelectedThread(undefined);
      }
      setDeleteTarget(null);
      await refresh(true);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete item");
    } finally {
      setDeleting(false);
    }
  };
  const stop = async () => {
    if (!latest) return;
    try {
      await api.cancel(latest.id);
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop run");
    }
  };
  const approve = async (decision: "approve" | "deny") => {
    const request = pendingApproval(latest);
    const requestId = request?.requestId ?? request?.id;
    if (!latest || !requestId) return;
    try {
      await api.approval(latest.id, { requestId, decision });
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record approval");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="icon-btn mobile-only"
          aria-label="Open navigation"
          onClick={() => setMobileNav(true)}
        >
          <Menu size={20} />
        </button>
        <div className="brand">
          <img
            className="brand-wordmark"
            src="/brand/opencode-bot-wordmark.png"
            alt="opencode bot"
          />
        </div>
        <div className="topbar-right">
          <span className={`connection ${connected ? "online" : "offline"}`}>
            {connected ? "Connected" : "Offline"}
          </span>
          <button
            className="icon-btn"
            aria-label="Refresh"
            onClick={() => refresh()}
          >
            <RefreshCw size={17} />
          </button>
          <div className="avatar">P</div>
        </div>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
          <div className="sidebar-head">
            <div className="eyebrow">YOUR WORKSPACE</div>
            <button
              className="icon-btn mobile-only"
              aria-label="Close navigation"
              onClick={() => setMobileNav(false)}
            >
              <X size={18} />
            </button>
          </div>
          <button
            className="new-chat"
            disabled={!bot}
            onClick={() => {
              setSurface("chat");
              createThread();
            }}
          >
            <Plus size={17} /> New conversation
          </button>
          <Tabs
            className="surface-tabs"
            value={surface}
            onValueChange={(value) => setSurface(value as typeof surface)}
          >
            <TabsList aria-label="Workspace areas">
              <TabsTrigger value="chat">
                <MessageSquare size={14} /> Chats
              </TabsTrigger>
              <TabsTrigger value="skills">
                <Zap size={14} /> Skills
              </TabsTrigger>
              <TabsTrigger value="files">
                <HardDrive size={14} /> Files
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="side-label">
            <span>BOTS</span>
            <button
              className="tiny-btn"
              aria-label="Create bot"
              onClick={() => openBotEditor()}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="bot-list">
            {state.bots.map((b) => (
              <button
                className={`bot-row ${b.id === bot?.id ? "selected" : ""}`}
                key={b.id}
                onClick={() => {
                  setSurface("chat");
                  setSelectedBot(b.id);
                  setSelectedThread(
                    state.threads.find((t) => t.botId === b.id)?.id,
                  );
                }}
              >
                <span className="bot-avatar-mini">
                  {b.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="bot-name">{b.name}</span>
                <span className="bot-model" title={b.model}>
                  {shortModel(b.model)}
                </span>
              </button>
            ))}
          </div>
          <div className="side-label threads-label">
            <span>CONVERSATIONS</span>
            <button
              className="icon-btn"
              aria-label={`New conversation with ${bot?.name ?? "bot"}`}
              disabled={!bot}
              onClick={() => void createThread()}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="thread-list">
            {state.threads
              .filter((t) => t.botId === bot?.id)
              .map((t) => (
                <button
                  key={t.id}
                  className={`thread-row ${t.id === thread?.id ? "selected" : ""}`}
                  onClick={() => {
                    setSurface("chat");
                    setSelectedThread(t.id);
                    setSelectedBot(t.botId);
                    setMobileNav(false);
                  }}
                >
                  <MessageSquare size={15} />
                  <span>{t.title || "Untitled thread"}</span>
                </button>
              ))}
          </div>
          <div className="sidebar-tools">
            <button
              className="footer-action"
              onClick={() => setShowRoutines(true)}
            >
              <CalendarClock size={15} /> Routines{" "}
              <span className="tool-count">
                {routines.filter((r) => r.enabled).length || ""}
              </span>
            </button>
            <button
              className="footer-action"
              onClick={() => setShowComputer(true)}
            >
              <HardDrive size={15} /> Computer & checkpoints
            </button>
          </div>
          <div className="sidebar-footer">
            <button
              className="footer-action"
              onClick={() => setShowSettings(true)}
            >
              <Settings size={15} /> Settings
            </button>
          </div>
        </aside>
        {mobileNav && (
          <div className="scrim" onClick={() => setMobileNav(false)} />
        )}
        {surface === "skills" ? (
          <SkillsWorkspace
            skills={skills}
            activeBot={bot}
            onChange={setSkills}
            onReview={(reviewPrompt) => {
              if (prompt.trim()) { setError('Your conversation has an unsent draft. Send or clear it before drafting a repository review.'); return; }
              setPrompt(reviewPrompt);
              setSurface('chat');
            }}
          />
        ) : surface === "files" ? (
          <FilesWorkspace />
        ) : (
          <main className="main">
            {(computerWarming || catalogWarming) && !computerOpen && (
              <div className="computer-warmup" role="status">
                <div>
                  <strong>Preparing your computer</strong>
                  <span>
                    Explore your workspace while it starts. Your bots will be ready shortly.
                  </span>
                </div>
                <button className="soft-btn" onClick={() => setComputerOpen(true)}>
                  View Computer
                </button>
              </div>
            )}
            <div className="conversation-head">
              <div>
                {bot ? (
                  <div className="crumb">
                    <span className="crumb-bot">
                      <span className="bot-avatar-mini">
                        {bot.name.slice(0, 1).toUpperCase()}
                      </span>
                      {bot.name}
                    </span>
                    <ChevronRight size={14} />
                    <span>{shortModel(bot.model)}</span>
                  </div>
                ) : null}
                <div className="conversation-title">
                  <h1>
                    {bot ? (thread?.title ?? "New conversation") : "Your bots"}
                  </h1>
                  {thread && (
                    <ConversationMenu
                      disabled={Boolean(working)}
                      onRename={() => {
                        setRenaming(thread);
                        setRenameValue(thread.title);
                      }}
                      onDelete={() => requestDeleteThread(thread)}
                    />
                  )}
                </div>
              </div>
              <div className="head-actions">
                {working && (
                  <>
                    <span className="working-pill">
                      <LoaderCircle size={14} className="spin" /> Working
                    </span>
                    <button className="stop-btn" onClick={stop}>
                      <CircleStop size={14} /> Stop
                    </button>
                  </>
                )}
                {thread && bot && (
                  <button
                    className="soft-btn"
                    onClick={() => setTerminalOpen(true)}
                    disabled={!!thread.nodeId}
                    title={
                      thread.nodeId
                        ? "Native terminal relay for owned computers is not available yet"
                        : "Open the native OpenCode terminal"
                    }
                  >
                    <TerminalSquare size={15} /> Native OpenCode
                  </button>
                )}
                <button
                  className="soft-btn"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Command size={15} /> Commands <kbd>/</kbd>
                </button>
                {bot && (
                  <button
                    className="soft-btn"
                    onClick={() => openBotEditor(bot)}
                  >
                    <BotIcon size={15} /> Bot settings
                  </button>
                )}
              </div>
            </div>
            {error && (
              <div className="error-banner">
                <AlertCircle size={17} />
                <span>{error}</span>
                <button onClick={() => refresh()}>
                  <RefreshCw size={14} /> Retry
                </button>
                <button className="dismiss" onClick={() => setError("")}>
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="chat-scroll" ref={chatScroll} onScroll={(event) => {
              const element = event.currentTarget;
              followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
            }}>
              {loading && !state.threads.length ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={22} />
                  <span>Loading workspace…</span>
                </div>
              ) : (
                <>
                  {!conversation.length && !latest && (
                    <div className="onboarding">
                      <div className="onboarding-icon">
                        <BotIcon size={22} />
                      </div>
                      <h2>
                        {bot
                          ? `Start a conversation with ${bot.name}`
                          : "Create your first bot"}
                      </h2>
                      <p>
                        {bot
                          ? "Describe a task below. Your bot will keep working after you close this window."
                          : "Give your bot a role, instructions, and a model, then assign its first task."}
                      </p>
                      {!bot && (
                        <button
                          className="primary-btn"
                          onClick={() => openBotEditor()}
                        >
                          <Plus size={15} /> Create bot
                        </button>
                      )}
                    </div>
                  )}
                  {conversation.map((item, i) => (
                    item.kind === "message" ? (
                      <MessageBubble key={item.message.id ?? i} message={item.message} bot={bot} />
                    ) : (
                      <DelegationCard
                        key={`delegation-${item.delegation.id}`}
                        item={item.delegation}
                        onNavigate={(botId, threadId) => {
                          setSelectedBot(botId);
                          setSelectedThread(threadId);
                        }}
                      />
                    )
                  ))}
                  {latest ? (
                    <RunProgress
                      run={latest}
                      tools={transcript.flatMap((message) =>
                        (message.parts ?? []).filter((part) => part.type === "tool"),
                      ) as import("./api").ToolPart[]}
                    />
                  ) : null}
                  {pendingApproval(latest) && (
                    <ApprovalCard
                      request={pendingApproval(latest)!}
                      onDecision={approve}
                    />
                  )}{" "}
                </>
              )}
            </div>
            {bot && (
              <div className="composer-wrap">
                <div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); acceptFiles([...event.dataTransfer.files]); }}>
                  <textarea
                    aria-label="Message your bot"
                    value={prompt}
                    onChange={(e) => { setPrompt(e.target.value); saveDraft(e.target.value); }}
                    onPaste={(event) => {
                      const files = [...event.clipboardData.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
                      if (files.length) {
                        event.preventDefault();
                        const pastedText = event.clipboardData.getData("text/plain");
                        if (pastedText) { setPrompt((current) => { const next = current + pastedText; saveDraft(next); return next; }); }
                        acceptFiles(files);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder={`Message ${bot.name}…`}
                    disabled={!bot}
                  />
                  <ChatAttachments attachments={attachments} onChange={applyAttachmentUpdate} onFiles={acceptFiles} uploading={attachmentsUploading} />
                  <div className="composer-foot">
                    <div className="composer-hints">
                      <span>
                        {latestStatus === "running" ||
                        latestStatus === "waiting_approval"
                          ? "Delivered at the next execution boundary"
                          : latestStatus === "queued" ||
                              latestStatus === "provisioning"
                            ? "Queued messages will be sent when the computer is available"
                            : "Shift + Enter for new line"}
                      </span>
                      <ModelPicker
                        models={catalog.models ?? []}
                        value={composerModel}
                        onChange={setComposerModel}
                      />
                    </div>
                    <button
                      className="send-btn"
                      onClick={submit}
                      disabled={
                        (!prompt.trim() && !attachments.length) || !bot || composerBusy
                      }
                      aria-label="Send message"
                      title="Send message"
                    >
                      <Send size={17} />
                    </button>
                  </div>
                </div>
                <p className="composer-note">
                  Bots share a trusted computer. Review permissions before
                  running sensitive tasks.
                </p>
              </div>
            )}
          </main>
        )}
        {surface === "chat" && (
          <ComputerPreview
            key={`${connectionRevision}:${thread?.nodeId ?? "cloudflare"}`}
            nodeId={thread?.nodeId}
            open={computerOpen}
            onToggle={() => setComputerOpen((value) => !value)}
          />
        )}
      </div>
      {renaming && (
        <Dialog open onOpenChange={(v) => !v && setRenaming(null)}>
          <DialogContent className="rename-dialog">
            <DialogTitle>Rename conversation</DialogTitle>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.renameThread(renaming.id, renameValue);
                  setRenaming(null);
                  await refresh(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <label className="field-label" htmlFor="conversation-name">
                Name
              </label>
              <input
                className="settings-input"
                id="conversation-name"
                autoFocus
                maxLength={160}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
              <div className="settings-actions">
                <button className="primary-btn" disabled={!renameValue.trim()}>
                  Save name
                </button>
                <button
                  type="button"
                  className="soft-btn"
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
          <DialogContent className="delete-dialog">
            <DialogTitle>
              Delete {deleteTarget.kind === "bot" ? "bot" : "conversation"}?
            </DialogTitle>
            <p className="settings-muted">
              {deleteTarget.kind === "bot"
                ? `Delete “${deleteTarget.item.name}” and all of its conversations and settings? Shared computer files remain.`
                : `Delete “${deleteTarget.item.title || "Untitled conversation"}” and its messages? Shared computer files remain.`}
            </p>
            {deleteError && <p role="alert" className="extension-error">{deleteError}</p>}
            <div className="settings-actions">
              <button
                type="button"
                className="soft-btn"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-btn"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting && <LoaderCircle size={15} className="spin" />}
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {showSettings && (
        <SettingsModal
          bots={state.bots}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setConnected(true);
            refresh();
            api
              .catalog()
              .then((value) => {
                setCatalog(value);
                setCatalogError("");
              })
              .catch((e) =>
                setCatalogError(
                  e instanceof Error ? e.message : "Live catalog unavailable",
                ),
              );
          }}
        />
      )}
      {showBot && (
        <BotModal
          bot={editingBot}
          models={catalog.models ?? []}
          agents={catalog.agents ?? []}
          onMemory={() => {
            setShowBot(false);
            setShowMemory(true);
          }}
          onClose={() => setShowBot(false)}
          onDelete={() => editingBot && requestDeleteBot(editingBot)}
          deleting={deleting && deleteTarget?.kind === "bot"}
          deleteDisabled={botWorking}
          onSaved={async (saved) => {
            setShowBot(false);
            setSelectedBot(saved.id);
            if (!editingBot) setSelectedThread(undefined);
            await refresh();
          }}
        />
      )}
      {showMemory && bot && (
        <MemoryModal bot={bot} onClose={() => setShowMemory(false)} />
      )}{" "}
      {showRoutines && (
        <RoutinesModal
          bots={state.bots}
          routines={routines}
          onChange={setRoutines}
          onClose={() => setShowRoutines(false)}
        />
      )}{" "}
      {showComputer && (
        <ComputerModal
          active={Boolean(nativeSessionLocked)}
          onClose={() => setShowComputer(false)}
        />
      )}{" "}
      {paletteOpen && (
        <CommandPalette
          catalog={catalog}
          catalogError={catalogError}
          messages={liveMessages}
          onClose={() => setPaletteOpen(false)}
          onNativeCommand={submitNativeCommand}
          onAction={submitNativeAction}
          onWebAction={performWebAction}
        />
      )}
      {terminalOpen && thread && (
        <Dialog open onOpenChange={(open) => !open && setTerminalOpen(false)}>
          <DialogContent className="terminal-dialog">
            <DialogTitle asChild>
              <h2>Native OpenCode terminal</h2>
            </DialogTitle>
            <React.Suspense fallback={<p>Opening terminal…</p>}>
              <NativeTerminal
                threadId={thread.id}
                sessionId={terminalSessionId}
                endpoint="/api/terminal"
                onClose={() => setTerminalOpen(false)}
              />
            </React.Suspense>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CommandPalette({
  catalog,
  catalogError,
  messages,
  onClose,
  onNativeCommand,
  onAction,
  onWebAction,
}: {
  catalog: Catalog;
  catalogError?: string;
  messages: Message[];
  onClose: () => void;
  onNativeCommand: (name: string) => void;
  onAction: (action: CatalogAction, messageID?: string) => void;
  onWebAction: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [messageID, setMessageID] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const native = (catalog.commands ?? []).filter((command) =>
    `${command.name} ${command.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const actions = (catalog.actions ?? []).filter((action) =>
    `${action.name} ${action.action ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const webActions = [
    { name: "models", description: "Open the live model picker" },
    { name: "agents", description: "Open bot settings and agent picker" },
    { name: "new", description: "Start a new conversation" },
    { name: "sessions", description: "Show conversations" },
    { name: "skills", description: "Open the Skills library" },
    { name: "files", description: "Open shared files" },
    { name: "computer", description: "Show the shared computer" },
    { name: "terminal", description: "Open Native OpenCode" },
    { name: "help", description: "Show command help" },
  ].filter((entry) =>
    `${entry.name} ${entry.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const chooseWeb = (name: string) => {
    onWebAction(name);
    onClose();
  };
  const chooseNative = (name: string) => {
    onNativeCommand(name);
    onClose();
  };
  const chooseAction = (action: CatalogAction) => {
    if (action.requires?.includes("messageID") && !messageID) return;
    onAction(
      action,
      action.requires?.includes("messageID") ? messageID : undefined,
    );
    onClose();
  };
  const total = actions.length + native.length + webActions.length;
  const move = (delta: number) =>
    setActiveIndex((index) => (total ? (index + delta + total) % total : 0));
  const activate = () => {
    const actionIndex = activeIndex;
    if (actionIndex < actions.length) chooseAction(actions[actionIndex]);
    else if (actionIndex < actions.length + native.length)
      chooseNative(native[actionIndex - actions.length].name);
    else
      chooseWeb(webActions[actionIndex - actions.length - native.length].name);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="command-dialog">
        <DialogTitle asChild>
          <h2>Command palette</h2>
        </DialogTitle>
        <p className="command-intro">
          {catalogError
            ? catalogError
            : "Live session commands, native actions, and workspace tools."}
        </p>
        <div className="command-search">
          <Search size={16} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-options"
            aria-activedescendant={`command-option-${activeIndex}`}
            aria-label="Search commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate();
              }
            }}
            placeholder="Search commands…"
          />
        </div>
        <div className="command-list" id="command-options" role="listbox">
          {actions.map((action, index) => (
            <div className="command-action-row" key={`action-${action.name}`}>
              <button
                id={`command-option-${index}`}
                className={`command-row ${activeIndex === index ? "active" : ""}`}
                role="option"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => chooseAction(action)}
                disabled={Boolean(
                  action.requires?.includes("messageID") && !messageID,
                )}
              >
                <span className="command-icon">
                  <Zap size={15} />
                </span>
                <span>
                  <strong>/{action.name}</strong>
                  <small>
                    {action.action === "revert-stage"
                      ? "Stage a revert for a selected message"
                      : action.action === "revert-commit"
                        ? "Commit the staged revert"
                        : "Native OpenCode session action"}
                  </small>
                </span>
                <em>action</em>
              </button>
              {action.requires?.includes("messageID") && (
                <select
                  className="command-message-select"
                  aria-label="Message to undo"
                  value={messageID}
                  onChange={(event) => setMessageID(event.target.value)}
                >
                  <option value="">Choose a message…</option>
                  {messages
                    .filter((message) => message.id)
                    .map((message) => (
                      <option key={message.id} value={message.id}>
                        {message.role} · {message.content.slice(0, 72)}
                      </option>
                    ))}
                </select>
              )}
            </div>
          ))}
          {native.map((entry, index) => {
            const position = actions.length + index;
            return (
              <button
                id={`command-option-${position}`}
                className={`command-row ${activeIndex === position ? "active" : ""}`}
                key={`native-${entry.name}`}
                role="option"
                onMouseEnter={() => setActiveIndex(position)}
                onClick={() => chooseNative(entry.name)}
              >
                <span className="command-icon">
                  <TerminalSquare size={15} />
                </span>
                <span>
                  <strong>/{entry.name}</strong>
                  <small>
                    {entry.description ?? "Native OpenCode session command"}
                  </small>
                </span>
                <em>native</em>
              </button>
            );
          })}
          {webActions.map((entry, index) => {
            const position = actions.length + native.length + index;
            return (
              <button
                id={`command-option-${position}`}
                className={`command-row ${activeIndex === position ? "active" : ""}`}
                key={`web-${entry.name}`}
                role="option"
                onMouseEnter={() => setActiveIndex(position)}
                onClick={() => chooseWeb(entry.name)}
              >
                <span className="command-icon">
                  <Command size={15} />
                </span>
                <span>
                  <strong>/{entry.name}</strong>
                  <small>{entry.description}</small>
                </span>
                <em>workspace</em>
              </button>
            );
          })}
          {!total && (
            <div className="command-empty">
              {catalogError
                ? "The live catalog could not be loaded."
                : `No commands match “${query}”.`}
            </div>
          )}
        </div>
        <div className="command-foot">
          <span>
            {catalog.runtime?.version
              ? `OpenCode ${catalog.runtime.version}`
              : "Live catalog"}
          </span>
          <kbd>Esc</kbd>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComputerPreview({
  nodeId,
  open,
  onToggle,
}: {
  nodeId?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [frame, setFrame] = useState<string>();
  const [error, setError] = useState("");
  const [warming, setWarming] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  const [reconnect, setReconnect] = useState(0);
  useEffect(() => {
    if (!open || nodeId || !visible) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: number | undefined;
    let frameTimer = window.setTimeout(
      () => controller.abort(new Error("Computer preview timed out")),
      30_000,
    );
    setError("");
    setWarming(false);
    setFrame(undefined);
    const load = async () => {
      try {
        const response = await api.preview(controller.signal);
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.startsWith("image/")) {
          const url = URL.createObjectURL(await response.blob());
          if (!cancelled) {
            previous.current && URL.revokeObjectURL(previous.current);
            previous.current = url;
            setFrame(url);
          }
          return;
        }
        const boundary =
          contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] ??
          contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
        if (!boundary || !response.body)
          throw new Error("Computer preview stream has no frame boundary");
        const reader = response.body.getReader();
        const marker = new TextEncoder().encode(`--${boundary}`);
        let buffer = new Uint8Array();
        const append = (chunk: Uint8Array) => {
          const next = new Uint8Array(buffer.length + chunk.length);
          next.set(buffer);
          next.set(chunk, buffer.length);
          buffer = next;
        };
        const find = (needle: Uint8Array, start = 0) => {
          outer: for (let i = start; i <= buffer.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++)
              if (buffer[i + j] !== needle[j]) continue outer;
            return i;
          }
          return -1;
        };
        while (!cancelled) {
          const result = await reader.read();
          if (result.done) break;
          append(result.value);
          if (buffer.length > 8 * 1024 * 1024)
            throw new Error("Computer preview stream is too large");
          let boundaryAt = find(marker);
          while (boundaryAt >= 0) {
            const headersAt = find(
              new Uint8Array([13, 10, 13, 10]),
              boundaryAt + marker.length,
            );
            if (headersAt < 0) break;
            const headerText = new TextDecoder().decode(
              buffer.slice(boundaryAt + marker.length, headersAt),
            );
            const length = Number(
              headerText.match(/content-length:\s*(\d+)/i)?.[1] ?? 0,
            );
            const bodyStart = headersAt + 4;
            if (!length || buffer.length < bodyStart + length) break;
            const body = buffer.slice(bodyStart, bodyStart + length);
            const url = URL.createObjectURL(
              new Blob([body], { type: "image/jpeg" }),
            );
            if (!cancelled) {
              window.clearTimeout(frameTimer);
              frameTimer = window.setTimeout(
                () =>
                  controller.abort(
                    new Error("Computer preview stopped responding"),
                  ),
                30_000,
              );
              previous.current && URL.revokeObjectURL(previous.current);
              previous.current = url;
              setFrame(url);
            }
            buffer = buffer.slice(bodyStart + length);
            boundaryAt = find(marker);
          }
        }
        await reader.cancel();
        reader.releaseLock();
        if (!cancelled) throw new Error("Preview disconnected. Reconnecting…");
      } catch (e) {
        if (!cancelled) {
          const message =
            e instanceof Error ? e.message : "Computer preview unavailable";
          setWarming(isComputerWarmingUpError(e));
          setError(
            isComputerWarmingUpError(e)
              ? "Preparing the computer. You can keep exploring your workspace."
              : message,
          );
          setFrame(undefined);
          if (
            !message.includes("Connection needs attention") &&
            !message.includes("recovery required")
          )
            retryTimer = window.setTimeout(
              () => setReconnect((value) => value + 1),
              Math.min(1000 * 2 ** Math.min(reconnect, 4), 15_000),
            );
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(frameTimer);
      controller.abort();
      previous.current && URL.revokeObjectURL(previous.current);
      previous.current = undefined;
    };
  }, [open, reconnect, nodeId, visible]);
  return (
    <aside
      className={`computer-rail ${open ? "computer-rail-open" : "computer-rail-closed"}`}
    >
      <button
        className="computer-rail-toggle"
        onClick={onToggle}
        aria-label={open ? "Hide computer preview" : "Show computer preview"}
        title={open ? "Hide computer preview" : "Show computer preview"}
        aria-expanded={open}
      >
        <Monitor size={15} />
        <span>{open ? "Computer" : "Show computer"}</span>
        <ChevronRight size={14} className={open ? "rotate-180" : ""} />
      </button>
      {open && nodeId ? (
        <div className="computer-preview">
          <p>
            This conversation runs on an owned computer. Its desktop stream is
            not available through the app yet.
          </p>
        </div>
      ) : (
        open && (
          <div className="computer-preview">
            <div className="computer-preview-head">
              <span>LIVE PREVIEW</span>
              <span className="preview-state">
                {warming ? "Starting" : error ? "Reconnecting" : frame ? "Streaming" : "Connecting"}
              </span>
            </div>
            {frame ? (
              <button
                type="button"
                className="computer-preview-expand"
                onClick={() => setExpanded(true)}
                aria-label="Expand live computer preview"
                title="Expand live computer preview"
              >
                <img src={frame} alt="Live view of the shared computer" />
                <span className="computer-preview-expand-icon" aria-hidden="true">
                  <Maximize2 size={16} />
                </span>
              </button>
            ) : (
              <div className="preview-placeholder">
                {warming ? (<><LoaderCircle size={17} className="spin" /><span>{error}</span></>) : error ? (
                  <>
                    <AlertCircle size={17} />
                    <span>{error}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReconnect((value) => value + 1)}
                    >
                      Reconnect
                    </Button>
                  </>
                ) : (
                  <>
                    <LoaderCircle size={17} className="spin" />
                    <span>Connecting to the shared computer…</span>
                  </>
                )}
              </div>
            )}
            <Dialog open={expanded} onOpenChange={setExpanded}>
              <DialogContent className="computer-preview-dialog">
                <DialogTitle className="computer-preview-dialog-title">
                  Live computer preview
                </DialogTitle>
                {frame && (
                  <img
                    src={frame}
                    alt="Live view of the shared computer"
                    className="computer-preview-expanded-frame"
                  />
                )}
              </DialogContent>
            </Dialog>
            <p>Shared by your bots. Close this panel to pause the preview.</p>
          </div>
        )
      )}
    </aside>
  );
}

function SkillsWorkspace({
  skills,
  activeBot,
  onChange,
  onReview,
}: {
  skills: Skill[];
  activeBot?: Bot;
  onChange: (items: Skill[]) => void;
  onReview: (prompt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Skill>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (activeBot)
      api
        .botSkills(activeBot.id)
        .then((items) => setAssigned(items.map((item) => item.id)))
        .catch(() => undefined);
  }, [activeBot?.id]);
  const start = (skill?: Skill) => {
    setEditing(skill);
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setInstructions(skill?.instructions ?? "");
    setOpen(true);
  };
  const save = async () => {
    if (!name.trim() || !instructions.trim()) return;
    try {
      setSaving(true);
      const payload = {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      };
      const item = editing
        ? await api.updateSkill(editing.id, payload)
        : await api.createSkill(payload);
      onChange(
        editing
          ? skills.map((value) => (value.id === item.id ? item : value))
          : [...skills, item],
      );
      setOpen(false);
      setMessage(editing ? "Skill updated" : "Skill created");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save skill");
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (skillId: string) => {
    if (!activeBot) return;
    const next = assigned.includes(skillId)
      ? assigned.filter((id) => id !== skillId)
      : [...assigned, skillId];
    setAssigned(next);
    try {
      await api.assignSkills(activeBot.id, next);
      setMessage(`Skills assigned to ${activeBot.name}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not assign skill");
    }
  };
  const remove = async (skill: Skill) => {
    if (!window.confirm(`Delete “${skill.name}”?`)) return;
    try {
      await api.deleteSkill(skill.id);
      onChange(skills.filter((item) => item.id !== skill.id));
      setAssigned(assigned.filter((id) => id !== skill.id));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not delete skill");
    }
  };
  return (
    <main className="main workspace-surface">
      <div className="surface-head">
        <div>
          <div className="eyebrow">WORKSPACE LIBRARY</div>
          <h1>Skills</h1>
          <p>
            Reusable instruction bundles your bots can carry into every run.
          </p>
        </div>
        <div className="skill-header-actions">
          <ExtensionDiscovery botName={activeBot?.name} onReview={onReview}/>
          <Button onClick={() => start()}><Plus size={15} /> New skill</Button>
        </div>
      </div>
      <div className="surface-layout">
        <section className="skill-grid" aria-label="Skills library">
          {skills.length ? (
            skills.map((skill) => (
              <article className="skill-card" key={skill.id}>
                <div className="skill-card-head">
                  <span className="skill-index">
                    {String(skills.indexOf(skill) + 1).padStart(2, "0")}
                  </span>
                  <div className="skill-card-actions">
                    <button
                      className="icon-btn"
                      aria-label={`Edit ${skill.name}`}
                      onClick={() => start(skill)}
                    >
                      <Settings size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Delete ${skill.name}`}
                      onClick={() => remove(skill)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
                <h2>{skill.name}</h2>
                <p>{skill.description || "No description yet."}</p>
                <div className="skill-foot">
                  <span>
                    {skill.instructions.length.toLocaleString()} chars
                  </span>
                  {activeBot && (
                    <label className="assign-toggle">
                      <input
                        type="checkbox"
                        checked={assigned.includes(skill.id)}
                        onChange={() => toggle(skill.id)}
                      />
                      <span>
                        {assigned.includes(skill.id) ? "Assigned" : "Assign"}
                      </span>
                    </label>
                  )}
                </div>
              </article>
            ))
          ) : (
            <div className="surface-empty">
              <Zap size={22} />
              <h2>No skills yet</h2>
              <p>Create a reusable instruction bundle from the button above.</p>
            </div>
          )}
        </section>
        <aside className="surface-aside">
          <div className="eyebrow">CURRENT BOT</div>
          <h2>{activeBot?.name ?? "No bot selected"}</h2>
          <p>
            {activeBot
              ? "Check a skill to include it in this bot’s next run."
              : "Create a bot to assign skills."}
          </p>
          <div className="aside-rule" />
          <div className="stat-row">
            <span>Library</span>
            <strong>{skills.length} skills</strong>
          </div>
          <div className="stat-row">
            <span>Assigned</span>
            <strong>{assigned.length}</strong>
          </div>
          {message && (
            <div className="surface-message" role="status">
              {message}
            </div>
          )}
        </aside>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="skill-dialog">
          <div className="modal-kicker">
            {editing ? "EDIT SKILL" : "NEW SKILL"}
          </div>
          <DialogTitle asChild>
            <h2>{editing ? "Edit skill" : "Create a skill"}</h2>
          </DialogTitle>
          <p className="modal-copy">
            Keep this focused on one repeatable capability.
          </p>
          <label className="field-label" htmlFor="skill-name">
            Name
          </label>
          <input
            id="skill-name"
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Research brief"
            autoFocus
          />
          <label className="field-label" htmlFor="skill-description">
            Description <span>optional</span>
          </label>
          <input
            id="skill-description"
            className="text-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short note for your team"
          />
          <label className="field-label" htmlFor="skill-instructions">
            Instructions
          </label>
          <textarea
            id="skill-instructions"
            className="text-area"
            rows={7}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Tell the bot exactly how to apply this skill…"
          />
          <div className="modal-actions">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || !instructions.trim() || saving}
              onClick={save}
            >
              {saving && <LoaderCircle size={14} className="spin" />}
              {editing ? "Save changes" : "Create skill"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function FilesWorkspace() {
  return <FilesExplorer />;
}

function MessageBubble({ message, bot }: { message: Message; bot?: Bot }) {
  const user = message.role === "user";
  const system = message.role === "system";
  const toolOnly = !message.content.trim() && message.parts?.some(part => part.type === "tool");
  return (
    <div className={`message-row ${user ? "user-row" : system ? "system-row" : "assistant-row"} ${toolOnly ? "tool-only-row" : ""}`}>
      {!system && !toolOnly && <div className={`message-avatar ${user ? "user-avatar" : "bot-avatar"}`}>
        {user ? "P" : (bot?.name?.[0]?.toUpperCase() ?? "B")}
      </div>}
      <div className="message-content">
        {!toolOnly && <div className="message-meta">
          <strong>{user ? "You" : system ? "Activity" : (bot?.name ?? "Bot")}</strong>
          {message.createdAt && <span>{fmtTime(message.createdAt)}</span>}
          {user && message.status && (
            <span>
              {message.status === "accepted"
                ? "Delivered"
                : message.status === "needs_review"
                  ? "Waiting"
                  : "Queued"}
            </span>
          )}
        </div>}
        {message.parts?.length ? (
          <div className="message-parts">
            {message.parts.map((part, index) =>
              part.type === "tool" ? (
                <ToolActivity key={part.id ?? index} part={part} />
              ) : (
                <MarkdownContent key={index} className="message-text">{part.text}</MarkdownContent>
              ),
            )}
          </div>
        ) : message.content ? (
          <MarkdownContent className="message-text">{message.content}</MarkdownContent>
        ) : null}
        <AttachmentCards attachments={message.attachments} />
        {message.error && (
          <div className="message-error" role="alert">
            <strong>Request failed</strong>
            <p>{message.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
function ApprovalCard({
  request,
  onDecision,
}: {
  request: ApprovalRequest;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    await onDecision(decision);
    setBusy(false);
  };
  const label = request.action ?? "Action requires approval";
  const detail =
    request.description ?? request.command ?? request.target ?? request.scope;
  return (
    <div className="approval-card">
      <div className="approval-title">
        <span className="approval-shield">
          <KeyRound size={15} />
        </span>
        <div>
          <strong>Approval needed</strong>
          <span>Review this action before the bot continues</span>
        </div>
      </div>
      <div className="approval-detail">
        <div className="approval-action">{label}</div>
        {detail && <pre>{detail}</pre>}
        {request.expiresAt && (
          <small>Expires {fmtTime(request.expiresAt)}</small>
        )}
      </div>
      <div className="approval-actions">
        <button
          className="deny-btn"
          disabled={busy}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
        <button
          className="approve-btn"
          disabled={busy}
          onClick={() => decide("approve")}
        >
          {busy && <LoaderCircle size={14} className="spin" />}Approve once
        </button>
      </div>
    </div>
  );
}
function MemoryModal({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setLoading(true);
      setItems(await api.memories(bot.id));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load memory");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [bot.id]);
  const add = async () => {
    if (!text.trim()) return;
    try {
      setSaving(true);
      const created = await api.addMemory(bot.id, text.trim());
      setItems((current) => [...current, created]);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add memory");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteMemory(bot.id, id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete memory");
    }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal memory-modal">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">{bot.name.toUpperCase()}</div>
            <h2>Bot memory</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <p className="modal-copy">
          Explicit memories are included in future runs for this bot.
        </p>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            {error}
            <button className="retry-inline" onClick={load}>
              Retry
            </button>
          </div>
        )}
        <div className="memory-add">
          <textarea
            className="text-area"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a durable fact or preference…"
            rows={3}
          />
          <button
            className="primary-btn"
            disabled={!text.trim() || saving}
            onClick={add}
          >
            {saving && <LoaderCircle size={14} className="spin" />}Add memory
          </button>
        </div>
        <div className="memory-list">
          {loading ? (
            <div className="memory-empty">
              <LoaderCircle size={17} className="spin" /> Loading memory…
            </div>
          ) : !items.length ? (
            <div className="memory-empty">No explicit memories yet.</div>
          ) : (
            items.map((item) => (
              <div className="memory-item" key={item.id}>
                <p>{item.content}</p>
                <button
                  className="icon-btn"
                  onClick={() => remove(item.id)}
                  aria-label="Delete memory"
                >
                  <X size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
function RoutinesModal({
  bots,
  routines,
  onChange,
  onClose,
}: {
  bots: Bot[];
  routines: Routine[];
  onChange: (items: Routine[]) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [interval, setInterval] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    const minutes = Number(interval);
    if (
      !botId ||
      !title.trim() ||
      !prompt.trim() ||
      !Number.isInteger(minutes) ||
      minutes < 5
    ) {
      setError("Choose a bot and an interval of at least 5 minutes.");
      return;
    }
    try {
      setBusy(true);
      const routine = await api.createRoutine({
        botId,
        title: title.trim(),
        prompt: prompt.trim(),
        intervalMinutes: minutes,
        enabled: true,
      });
      onChange([...routines, routine]);
      setTitle("");
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create routine");
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (routine: Routine) => {
    try {
      const updated = await api.updateRoutine(routine.id, {
        enabled: !routine.enabled,
      });
      onChange(
        routines.map((item) =>
          item.id === routine.id
            ? {
                ...item,
                ...updated,
                enabled: updated.enabled ?? !routine.enabled,
              }
            : item,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update routine");
    }
  };
  const remove = async (routine: Routine) => {
    if (!window.confirm(`Delete “${routine.title}”?`)) return;
    try {
      await api.deleteRoutine(routine.id);
      onChange(routines.filter((item) => item.id !== routine.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete routine");
    }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal routine-modal">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">AUTOMATION</div>
            <h2>Routines</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <p className="modal-copy">
          Run a bot on a fixed interval. Times are shown in the control worker’s
          configured clock.
        </p>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}
        <div className="routine-form">
          <select
            className="text-input"
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            aria-label="Bot"
          >
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <input
            className="text-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Routine title"
          />
          <textarea
            className="text-area"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the bot do?"
            rows={3}
          />
          <div className="interval-row">
            <label>
              Every{" "}
              <input
                className="text-input interval-input"
                type="number"
                min="5"
                step="1"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />{" "}
              minutes
            </label>
            <button className="primary-btn" disabled={busy} onClick={create}>
              {busy && <LoaderCircle size={14} className="spin" />}Create
              routine
            </button>
          </div>
        </div>
        <div className="routine-list">
          {!routines.length ? (
            <div className="memory-empty">No routines yet.</div>
          ) : (
            routines.map((routine) => (
              <div className="routine-item" key={routine.id}>
                <div className="routine-state">
                  {routine.enabled ? <Play size={13} /> : <Pause size={13} />}
                </div>
                <div className="routine-copy">
                  <strong>{routine.title}</strong>
                  <span>
                    {bots.find((bot) => bot.id === routine.botId)?.name ??
                      "Bot"}{" "}
                    · every {routine.intervalMinutes} min
                    {routine.nextRunAt
                      ? ` · next ${fmtTime(routine.nextRunAt)}`
                      : ""}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => toggle(routine)}
                  aria-label={
                    routine.enabled ? "Pause routine" : "Resume routine"
                  }
                >
                  {routine.enabled ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="icon-btn"
                  onClick={() => remove(routine)}
                  aria-label="Delete routine"
                >
                  <X size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
function ComputerModal({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<ComputerStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setLoading(true);
      setStatus(await api.computerStatus());
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load computer status",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const checkpoint = async () => {
    try {
      setBusy(true);
      setStatus(await api.checkpoint());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create checkpoint");
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (active) return;
    if (
      !window.confirm(
        "Restore the last checkpoint? Local computer files changed since that checkpoint may be replaced.",
      )
    )
      return;
    try {
      setBusy(true);
      setStatus(
        await api.restoreCheckpoint(
          status?.checkpoint?.id ?? status?.lastCheckpoint?.id,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore checkpoint");
    } finally {
      setBusy(false);
    }
  };
  const cp = status?.checkpoint ?? status?.lastCheckpoint;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">EXECUTION COMPUTER</div>
            <h2>Computer & checkpoints</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            {error}
            <button className="retry-inline" onClick={load}>
              Retry
            </button>
          </div>
        )}
        <div className="computer-status">
          <div>
            <strong>
              {loading
                ? "Checking status…"
                : active
                  ? "Run active"
                  : status?.readiness === "restore_required"
                    ? "Recovery required"
                    : (status?.status ??
                      status?.state ??
                      status?.phase ??
                      "Unknown")}
            </strong>
            <span>
              {status?.computerId
                ? `Computer ${status.computerId}`
                : "Cloud execution computer"}
            </span>
          </div>
        </div>
        <div className="checkpoint-panel">
          <div className="checkpoint-label">
            <HardDrive size={15} /> Last durable checkpoint
          </div>
          {cp ? (
            <>
              <strong>
                {cp.createdAt
                  ? new Date(cp.createdAt).toLocaleString()
                  : "Available"}
              </strong>
              <span>
                {cp.sizeBytes
                  ? `${Math.round((cp.sizeBytes ?? cp.bytes ?? 0) / 1024)} KB`
                  : "Manifest recorded"}{" "}
                · application checkpoint
              </span>
            </>
          ) : (
            <span>No checkpoint has been committed yet.</span>
          )}
        </div>
        <p className="modal-copy">
          Checkpointing captures the application’s committed computer state. It
          does not guarantee recovery of work still in progress.
        </p>
        <div className="modal-actions">
          <button className="soft-btn" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            className="soft-btn"
            disabled={busy || active || !cp}
            onClick={restore}
          >
            Restore checkpoint
          </button>
          <button
            className="primary-btn"
            disabled={busy || active}
            onClick={checkpoint}
          >
            {busy && <LoaderCircle size={14} className="spin" />}Create
            checkpoint
          </button>
        </div>
        {active && (
          <div className="modal-note">
            Checkpoint and restore are disabled while a run is active.
          </div>
        )}
      </div>
    </div>
  );
}
function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: CatalogModel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pickerId = React.useId();
  const normalized = models
    .map((model) => ({
      model,
      id: model.providerID
        ? `${model.providerID}/${model.id}`
        : String(model.id ?? model.name ?? ""),
      provider: String(model.providerID ?? model.provider ?? ""),
    }))
    .filter((item) => item.id);
  const filtered = normalized.filter((item) =>
    `${item.id} ${item.provider}`.toLowerCase().includes(query.toLowerCase()),
  );
  const priceTier = (model: CatalogModel) => {
    const raw = JSON.stringify(model.cost ?? model.pricing ?? "").toLowerCase();
    if (!raw || raw === '""' || raw === "null" || raw === "false")
      return "unknown";
    const numbers = [
      ...raw.matchAll(
        /(?:input|output|prompt|completion)[^0-9]*([0-9]+(?:\.[0-9]+)?)/g,
      ),
    ].map((match) => Number(match[1]));
    if (numbers.length >= 2 && numbers.every((number) => number === 0))
      return "free";
    if (numbers.some((number) => number > 0)) return "paid";
    return "unknown";
  };
  return (
    <div className="model-picker">
      <div className="model-picker-input">
        <Search size={14} />
        <input
          id={pickerId}
          aria-label="Model"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${pickerId}-options`}
          value={open ? query : value}
          title={value}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={models.length ? "Search live models…" : "provider/model"}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Toggle model options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery("");
            setOpen((value) => !value);
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && models.length > 0 && (
        <div
          className="model-options"
          id={`${pickerId}-options`}
          role="listbox"
        >
          {(["free", "paid", "unknown"] as const).map((tier) => {
            const group = filtered.filter(
              (item) => priceTier(item.model) === tier,
            );
            return group.length ? (
              <div key={tier}>
                <div className="model-group-label">
                  {tier === "paid"
                    ? "Paid"
                    : tier === "free"
                      ? "Free / included"
                      : "Pricing unavailable"}
                </div>
                {group.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === item.id}
                    className="model-option"
                    key={item.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onChange(item.id);
                      setQuery(item.id);
                      setOpen(false);
                    }}
                  >
                    <span>{item.id}</span>
                    <small>{item.provider || "catalog"}</small>
                  </button>
                ))}
              </div>
            ) : null;
          })}
          {!filtered.length && (
            <div className="model-empty">No live models match.</div>
          )}
        </div>
      )}
    </div>
  );
}
function ConversationMenu({
  disabled,
  onRename,
  onDelete,
}: {
  disabled?: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="icon-btn rename-conversation" aria-label="Conversation actions" disabled={disabled} title={disabled ? "Stop the active run before managing this conversation" : "Conversation actions"}><MoreHorizontal size={16}/></button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="conversation-action-menu" sideOffset={6} align="start">
          <DropdownMenu.Item onSelect={onRename}>Rename</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-danger" onSelect={onDelete}><Trash2 size={14}/> Delete</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BotModal({
  bot,
  models,
  agents,
  onClose,
  onMemory,
  onDelete,
  deleting,
  deleteDisabled,
  onSaved,
}: {
  bot?: Bot;
  models: CatalogModel[];
  agents: CatalogAgent[];
  onClose: () => void;
  onMemory: () => void;
  onDelete: () => void;
  deleting?: boolean;
  deleteDisabled?: boolean;
  onSaved: (bot: Bot) => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [model, setModel] = useState(bot?.model ?? "");
  const [agent, setAgent] = useState(bot?.agent ?? "");
  const [nodeId, setNodeId] = useState(bot?.nodeId ?? "");
  const [nodes, setNodes] = useState<
    Array<{ id: string; name: string; online: boolean; revokedAt?: string }>
  >([]);
  useEffect(() => {
    void request<{
      nodes: Array<{
        id: string;
        name: string;
        online: boolean;
        revokedAt?: string;
      }>;
    }>("/api/nodes")
      .then((r) => setNodes(r.nodes.filter((n) => !n.revokedAt)))
      .catch(() => {});
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        instructions: instructions.trim(),
        model: model.trim(),
        agent: agent.trim(),
        nodeId,
      };
      const saved = bot
        ? await api.updateBot(bot.id, payload)
        : await api.bot(payload);
      await onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save bot");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal bot-modal">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">BOT PROFILE</div>
            <h2>{bot ? "Bot settings" : "Create a bot"}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {error && (
          <div className="inline-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}
        <label className="field-label" htmlFor="bot-name">
          Name
        </label>
        <input
          className="text-input"
          id="bot-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Researcher"
          autoFocus
        />
        <label className="field-label" htmlFor="model-picker">
          Model <span>optional</span>
        </label>
        <ModelPicker models={models} value={model} onChange={setModel} />
        <label className="field-label" htmlFor="bot-agent">
          Agent <span>live catalog</span>
        </label>
        <select
          id="bot-agent"
          className="text-input"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value="">Default agent</option>
          {agents.map((item) => (
            <option
              key={String(item.id ?? item.name)}
              value={String(item.id ?? item.name)}
            >
              {String(item.name ?? item.id)}
              {item.description ? ` — ${item.description}` : ""}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="bot-computer">
          Computer
        </label>
        <select
          className="text-input"
          id="bot-computer"
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
        >
          <option value="">Cloudflare · default</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
              {n.online ? "" : " · offline"}
            </option>
          ))}
        </select>
        <p className="settings-muted">
          Used for new conversations. Existing conversations stay on their
          original computer.
        </p>
        <label className="field-label" htmlFor="bot-instructions">
          Instructions <span>optional</span>
        </label>
        <textarea
          className="text-area"
          id="bot-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should this bot be great at?"
          rows={5}
        />
        {bot && (
          <button className="memory-link" onClick={onMemory}>
            <FileText size={14} /> Inspect bot memory <ChevronRight size={14} />
          </button>
        )}
        {bot && (
          <div className="destructive-section">
            <div>
              <strong>Delete this bot</strong>
              <p>Removes this bot, its conversations, and settings. Shared computer files remain.</p>
            </div>
            <button className="danger-btn" type="button" onClick={onDelete} disabled={deleting || deleteDisabled} title={deleteDisabled ? "Stop the active run before deleting this bot" : undefined}>
              <Trash2 size={14} /> Delete bot
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button className="soft-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-btn"
            disabled={!name.trim() || saving}
            onClick={save}
          >
            {saving && <LoaderCircle size={15} className="spin" />}
            {saving ? "Saving…" : "Save bot"}
          </button>
        </div>
      </div>
    </div>
  );
}
function colorFor(id?: string) {
  const colors = ["#e07a5f", "#6d8ee8", "#67a68b", "#c18ade", "#d5a34b"];
  if (!id) return colors[0];
  return colors[
    [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length
  ];
}
function shortModel(model?: string) {
  if (!model) return "default";
  return model.split("/").pop()?.split("#")[0] ?? model;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DeviceConnectionGate><App /></DeviceConnectionGate>
  </React.StrictMode>,
);
