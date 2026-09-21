import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { api } from "../../src/api";
import { useStore } from "../../src/store";
import { colors, styles } from "../../src/ui";
import { Markdown } from "../../src/markdown";
import type {
  Approval,
  Attachment,
  Message,
  Run,
  RunEvent,
} from "../../src/types";

const ACTIVE = new Set([
  "queued",
  "provisioning",
  "running",
  "waiting_approval",
  "waiting_human",
  "recovering",
  "checkpointing",
  "cancelling",
]);
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "completed",
  "error",
  "needs_review",
  "restore_required",
  "restorerequired",
]);
const lifecycle = new Set([
  "run.queued",
  "runner.session.created",
  "runner.approval.requested",
  "runner.connection.recovering",
  "runner.connection.failed",
  "runner.session.action.completed",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.needs_review",
]);
const terminalLifecycle = new Set([
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.needs_review",
  "runner.recovery.needs_review",
  "runner.recovery.required",
]);
const humanTool: Record<string, string> = {
  browser_navigate: "Open page",
  browser_snapshot: "Inspect page",
  browser_click: "Click page element",
  shell: "Run command",
  exec: "Run command",
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  glob: "Find files",
  grep: "Search files",
  delegate: "Delegate task",
};
const toolLabel = (name: string) =>
  humanTool[name.toLowerCase().replace(/[.\s-]+/g, "_")] ??
  name.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const eventLabel = (event: RunEvent) =>
  ({
    "run.queued": "Task queued",
    "runner.session.created": "Workspace ready",
    "runner.approval.requested": "Approval requested",
    "runner.connection.recovering": "Reconnecting",
    "runner.connection.failed": "Connection failed",
    "runner.session.action.completed": "Session action completed",
    "run.succeeded": "Task finished",
    "run.failed": "Task failed",
    "run.cancelled": "Task stopped",
    "run.needs_review": "Review needed",
  })[event.type ?? ""] ?? "Task activity";
const elapsed = (run: Run) => {
  const start = Date.parse(run.startedAt ?? "");
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  return seconds > 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
};
const normalizedStatus = (status: string | undefined) =>
  (status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const latestLifecycleEvent = (run: Run) => {
  const events = (run.events ?? []).filter((event) => event.type);
  return events.reduce<RunEvent | undefined>((latest, event) => {
    if (!latest) return event;
    const latestTime = Date.parse(latest.createdAt ?? "");
    const eventTime = Date.parse(event.createdAt ?? "");
    if (!Number.isFinite(eventTime) && !Number.isFinite(latestTime)) return event;
    return Number.isFinite(eventTime) && (!Number.isFinite(latestTime) || eventTime >= latestTime)
      ? event
      : latest;
  }, undefined);
};
const hasTerminalLifecycle = (run: Run) => {
  const eventType = latestLifecycleEvent(run)?.type ?? "";
  return terminalLifecycle.has(eventType) || eventType.includes("restore_required");
};
const actionableApproval = (run: Run, approval?: Approval) =>
  Boolean(approval) &&
  normalizedStatus(run.status) === "waiting_approval" &&
  !hasTerminalLifecycle(run);
const approvalKey = (run: Run, approval: Approval) =>
  `${run.id}:${approval.requestId ?? approval.id ?? "approval"}`;
const approvalDescription = (approval: Approval) => {
  const action = approval.action ? toolLabel(approval.action) : "Continue this task";
  const extra = approval as Approval & { resources?: unknown; source?: unknown };
  const target = approval.target ?? approval.command ??
    (typeof extra.source === "string" ? extra.source : undefined);
  const resources = Array.isArray(extra.resources)
    ? extra.resources.filter((item): item is string => typeof item === "string").join(", ")
    : "";
  return target ? `${action}: ${target}${resources ? ` (${resources})` : ""}` : resources ? `${action}: ${resources}` : action;
};
type Tool = Extract<NonNullable<Message["parts"]>[number], { type: "tool" }>;

function ToolRow({ part }: { part: Tool }) {
  const [open, setOpen] = useState(false);
  const input = (part as any).input;
  const target =
    typeof input?.url === "string"
      ? input.url
      : typeof input?.path === "string"
        ? input.path
        : typeof input?.command === "string"
          ? input.command
          : "";
  const detail = part.output ?? part.error ?? "";
  const preview = detail.split("\n").find(Boolean)?.slice(0, 180) ?? "";
  const running = part.status === "running" || part.status === "queued";
  return (
    <View style={mobileStyles.toolRow}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        style={mobileStyles.toolHeader}
      >
        <Text style={mobileStyles.toolIcon}>
          {running ? "○" : part.status === "failed" ? "!" : "✓"}
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={mobileStyles.toolName}>{toolLabel(part.name)}</Text>
          {target ? (
            <Text numberOfLines={1} style={mobileStyles.toolTarget}>
              {target}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text style={mobileStyles.chevron}>{open ? "⌄" : "›"}</Text>
        ) : null}
      </Pressable>
      {!running && preview ? (
        <Text numberOfLines={1} style={mobileStyles.toolPreview}>
          {preview}
        </Text>
      ) : null}
      {open && detail ? (
        <Text selectable style={mobileStyles.toolDetail}>
          {detail.slice(0, 16000)}
        </Text>
      ) : null}
    </View>
  );
}

function MessageCard({
  message,
  botName,
}: {
  message: Message;
  botName?: string;
}) {
  const user = message.role === "user";
  const toolOnly =
    !message.content.trim() &&
    message.parts?.some((part) => part.type === "tool");
  return (
    <View
      style={[
        mobileStyles.messageRow,
        { alignItems: user ? "flex-end" : "flex-start" },
      ]}
    >
      <View
        style={[
          mobileStyles.message,
          user ? mobileStyles.userMessage : undefined,
          toolOnly ? mobileStyles.toolOnly : undefined,
        ]}
      >
        {!toolOnly ? (
          <Text style={mobileStyles.messageLabel}>
            {user ? "You" : (botName ?? "Bot")}
            {message.createdAt
              ? `  ${new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : ""}
          </Text>
        ) : null}
        {message.parts?.length ? (
          message.parts.map((part, index) =>
            part.type === "tool" ? (
              <ToolRow key={part.id ?? index} part={part} />
            ) : (
              <Markdown key={index} value={part.text} compact />
            ),
          )
        ) : message.content ? (
          <Markdown value={message.content} />
        ) : null}
        {message.attachments?.map((file) => (
          <View key={file.id} style={mobileStyles.historyFile}>
            <Text style={mobileStyles.fileIcon}>□</Text>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={mobileStyles.fileName}>
                {file.name}
              </Text>
              <Text style={mobileStyles.fileMeta}>
                {file.mimeType} · {file.size} bytes
              </Text>
            </View>
          </View>
        ))}
        {message.error ? (
          <Text style={styles.error}>{message.error}</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useStore();
  const transcriptView = useRef<ScrollView>(null);
  const nearBottom = useRef(true);
  const thread = store.state?.threads.find((item) => item.id === id);
  const client = useMemo(() => api(store.baseUrl), [store.baseUrl]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inFlight = useRef(false);
  const approvalInFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const loadSerial = useRef(0);
  const load = useCallback(async () => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    const serial = ++loadSerial.current;
    try {
      const [transcript, state] = await Promise.all([
        client.messages(id),
        client.state(),
      ]);
      if (!mounted.current || serial !== loadSerial.current) return;
      const threadRuns = (state.runs ?? []).filter(
        (run) => run.threadId === id,
      );
      const refreshed = await Promise.all(
        threadRuns
          .filter((run) => !terminal.has(normalizedStatus(run.status)))
          .map(async (run) => {
            try {
              const [detail, events] = await Promise.all([
                client.runDetail(run.id),
                client.events(run.id),
              ]);
              return { ...detail, events };
            } catch {
              return run;
            }
          }),
      );
      if (!mounted.current || serial !== loadSerial.current) return;
      const byId = new Map(refreshed.map((run) => [run.id, run]));
      setMessages(
        transcript.messages ??
          state.messages?.[id] ??
          state.threadMessages?.[id] ??
          [],
      );
      setRuns(threadRuns.map((run) => byId.get(run.id) ?? run));
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Could not load conversation.",
        );
    } finally {
      inFlight.current = false;
    }
  }, [client, id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (AppState.currentState === "active" && !inFlight.current) void load();
    };
    const timer = setInterval(
      refresh,
      runs.some((run) => ACTIVE.has(run.status)) ? 3000 : 5000,
    );
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [runs, load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSerial.current += 1;
    };
  }, []);
  async function uploadPickedFile(file: {
    uri: string;
    name: string;
    mimeType?: string | null;
    size?: number | null;
  }) {
    if (attachments.length >= 8 || busy) return;
    if (file.size && file.size > 10 * 1024 * 1024) {
      setError("Attachments must be 10 MiB or smaller.");
      return;
    }
    if (
      attachments.reduce((sum, item) => sum + item.size, 0) + (file.size ?? 0) >
      20 * 1024 * 1024
    ) {
      setError("Attachments must total 20 MiB or less.");
      return;
    }
    setBusy(true);
    try {
      const uploaded = await client.upload({
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType ?? undefined,
      });
      setAttachments((current) => [...current, uploaded.attachment]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload attachment.");
    } finally {
      setBusy(false);
    }
  }
  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const file = result.assets[0];
      await uploadPickedFile({
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the file picker.");
    }
  }
  async function pickPhoto(useCamera: boolean) {
    try {
      if (useCamera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError("Camera access is unavailable. Allow camera access in Settings, or choose a photo or file.");
          return;
        }
      } else {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          setError("Photo access is unavailable. Allow photo access in Settings, or choose a file.");
          return;
        }
      }
      const result = useCamera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            quality: 0.9,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            quality: 0.9,
          });
      if (result.canceled) return;
      const file = result.assets[0];
      await uploadPickedFile({
        uri: file.uri,
        name: file.fileName ?? `photo-${Date.now()}.jpg`,
        mimeType: file.mimeType ?? "image/jpeg",
        size: file.fileSize,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the camera or photo library.");
    }
  }
  function pickAttachment() {
    if (attachments.length >= 8 || busy) return;
    const actions = [
      { text: "Take photo", onPress: () => void pickPhoto(true) },
      { text: "Choose photo", onPress: () => void pickPhoto(false) },
      { text: "Choose file", onPress: () => void pickFile() },
      ...(Platform.OS === "android" ? [] : [{ text: "Cancel", style: "cancel" as const }]),
    ];
    // Android Alert supports at most three action buttons. The system back
    // gesture dismisses this chooser when no explicit Cancel button is shown.
    Alert.alert("Add attachment", "Choose where to get your file.", actions);
  }
  async function send() {
    if ((!draft.trim() && !attachments.length) || busy || !id) return;
    const prompt = draft.trim() || "Review the attached files.";
    const files = attachments;
    setDraft("");
    setAttachments([]);
    setBusy(true);
    setError("");
    try {
      const run = await client.run(
        id,
        prompt,
        `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        files,
      );
      setRuns((current) => [
        ...current.filter((item) => item.id !== run.id),
        run,
      ]);
      await load();
    } catch (e) {
      setDraft(prompt === "Review the attached files." ? "" : prompt);
      setAttachments(files);
      setError(e instanceof Error ? e.message : "Could not start task.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(run: Run) {
    try {
      await client.cancel(run.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel task.");
    }
  }
  async function decide(
    run: Run,
    approval: Approval,
    decision: "approve" | "deny",
  ) {
    const key = approvalKey(run, approval);
    if (!actionableApproval(run, approval) || approvalInFlight.current.has(key)) return;
    approvalInFlight.current.add(key);
    setApprovalBusy(key);
    try {
      await client.approve(run.id, approval, decision);
      setError("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update approval.");
    } finally {
      approvalInFlight.current.delete(key);
      setApprovalBusy((current) => (current === key ? null : current));
    }
  }
  async function rename() {
    if (!id || !renameValue.trim()) return;
    try {
      await client.renameThread(id, renameValue.trim());
      setRenaming(false);
      await store.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not rename conversation.",
      );
    }
  }
  async function removeThread() {
    if (!id) return;
    try {
      await client.deleteThread(id);
      await store.refresh();
      router.back();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not delete conversation.",
      );
    }
  }
  function openMenu() {
    Alert.alert(thread?.title ?? "Conversation", undefined, [
      {
        text: "Rename",
        onPress: () => {
          setRenameValue(thread?.title ?? "");
          setRenaming(true);
        },
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          Alert.alert("Delete conversation?", "This cannot be undone.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => void removeThread(),
            },
          ]),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }
  const approval = runs
    .map((run) => ({
      run,
      approval: run.pendingApproval ?? run.approval ?? run.approvalRequest,
    }))
    .find((item) => actionableApproval(item.run, item.approval));
  const activity = runs
    .flatMap((run) =>
      (run.events ?? [])
        .filter((event) => lifecycle.has(event.type ?? ""))
        .map((event) => ({ run, event })),
    )
    .slice(-12);
  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={mobileStyles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={mobileStyles.back}>‹</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={mobileStyles.title}>
              {thread?.title ?? "Conversation"}
            </Text>
          </View>
          <Pressable
            onPress={() =>
              Alert.alert("Conversation", thread?.title, [
                {
                  text: "Rename",
                  onPress: () => {
                    setRenameValue(thread?.title ?? "");
                    setRenaming(true);
                  },
                },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () =>
                    Alert.alert(
                      "Delete conversation?",
                      "This cannot be undone.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => void removeThread(),
                        },
                      ],
                    ),
                },
                { text: "Cancel", style: "cancel" },
              ])
            }
            hitSlop={10}
          >
            <Text style={mobileStyles.more}>•••</Text>
          </Pressable>
        </View>
        {renaming ? (
          <View style={mobileStyles.rename}>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              style={[styles.input, { flex: 1, paddingVertical: 9 }]}
              placeholder="Conversation name"
              placeholderTextColor={colors.muted}
            />
            <Pressable onPress={() => void rename()} style={styles.button}>
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>
            <Pressable onPress={() => setRenaming(false)}>
              <Text style={styles.ghostText}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
        <ScrollView
          ref={transcriptView}
          contentContainerStyle={mobileStyles.scroll}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={100}
          onScroll={({ nativeEvent: e }) => {
            nearBottom.current =
              e.contentSize.height -
                e.layoutMeasurement.height -
                e.contentOffset.y <
              100;
          }}
          onContentSizeChange={() => {
            if (nearBottom.current)
              transcriptView.current?.scrollToEnd({ animated: false });
          }}
        >
          {!messages.length && !runs.length && !error ? (
            <View style={mobileStyles.empty}>
              <Text style={mobileStyles.emptyTitle}>Start a conversation</Text>
              <Text style={styles.subtitle}>
                Describe what you want your bot to inspect, build, or explain.
              </Text>
            </View>
          ) : null}
          {[
            ...messages.map((message, index) => ({
              key: `message-${message.id ?? index}`,
              time: Date.parse(message.createdAt ?? "") || 0,
              node: (
                <MessageCard
                  message={message}
                  botName={
                    store.state?.bots.find((bot) => bot.id === thread?.botId)
                      ?.name
                  }
                />
              ),
            })),
            ...activity.map(({ run, event }, index) => ({
              key: `event-${run.id}-${event.id ?? index}`,
              time: Date.parse(event.createdAt ?? "") || 0,
              node: (
                <View style={mobileStyles.notice}>
                  <Text style={mobileStyles.noticeTitle}>
                    {eventLabel(event)}
                  </Text>
                  <Text style={mobileStyles.noticeText}>
                    {event.createdAt
                      ? new Date(event.createdAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : ""}
                  </Text>
                </View>
              ),
            })),
          ]
            .sort((a, b) => a.time - b.time)
            .map((item) => (
              <View key={item.key}>{item.node}</View>
            ))}
          {approval ? (
            <View style={[styles.card, { borderColor: colors.accent }]}>
              <Text style={mobileStyles.approvalTitle}>Approval required</Text>
              <Text style={[styles.subtitle, { marginTop: 7 }]}>
                {approval.approval?.description ?? approvalDescription(approval.approval!)}
              </Text>
              <View style={mobileStyles.actions}>
                <Pressable
                  disabled={approvalBusy !== null}
                  style={[styles.button, { flex: 1 }, approvalBusy !== null && { opacity: 0.6 }]}
                  onPress={() =>
                    void decide(approval.run, approval.approval!, "approve")
                  }
                >
                  {approvalBusy === approvalKey(approval.run, approval.approval!) ? (
                    <ActivityIndicator color={colors.text} size="small" />
                  ) : (
                    <Text style={styles.buttonText}>Approve</Text>
                  )}
                </Pressable>
                <Pressable
                  disabled={approvalBusy !== null}
                  style={[styles.ghost, { flex: 1 }, approvalBusy !== null && { opacity: 0.6 }]}
                  onPress={() =>
                    void decide(approval.run, approval.approval!, "deny")
                  }
                >
                  <Text style={styles.ghostText}>Deny</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {runs
            .filter(
              (run) =>
                ACTIVE.has(normalizedStatus(run.status)) &&
                !hasTerminalLifecycle(run),
            )
            .map((run) => (
              <View key={run.id} style={mobileStyles.progress}>
                <View style={{ flex: 1 }}>
                  <Text style={mobileStyles.progressTitle}>
                    {run.status === "waiting_approval"
                      ? "Waiting for approval"
                      : run.events?.length
                        ? eventLabel(run.events[run.events.length - 1])
                        : "Preparing a response"}
                  </Text>
                  <Text style={mobileStyles.progressMeta}>
                    {elapsed(run)}
                    {run.events?.length
                      ? ` · ${run.events.length} updates`
                      : ""}
                  </Text>
                </View>
                <ActivityIndicator color={colors.muted} size="small" />
                <Pressable
                  onPress={() => void cancel(run)}
                  style={styles.ghost}
                >
                  <Text style={styles.ghostText}>Stop</Text>
                </Pressable>
              </View>
            ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
        <View style={mobileStyles.composer}>
          <View style={mobileStyles.composerTop}>
            {attachments.map((file) => (
              <Pressable
                key={file.id}
                onPress={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
                style={mobileStyles.chip}
              >
                <Text numberOfLines={1} style={mobileStyles.chipText}>
                  {file.name} ×
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={mobileStyles.composerRow}>
            <Pressable
              style={styles.ghost}
              disabled={busy || attachments.length >= 8}
              onPress={() => void pickAttachment()}
            >
              <Text style={mobileStyles.attach}>＋</Text>
            </Pressable>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder="Message your bot…"
              placeholderTextColor={colors.muted}
              style={[styles.input, mobileStyles.editor]}
            />
            <Pressable
              style={[
                styles.button,
                {
                  paddingHorizontal: 15,
                  opacity:
                    (!draft.trim() && !attachments.length) || busy ? 0.5 : 1,
                },
              ]}
              disabled={(!draft.trim() && !attachments.length) || busy}
              onPress={() => void send()}
            >
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const mobileStyles = {
  header: {
    paddingTop: 8,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { color: colors.accent, fontSize: 30, lineHeight: 30 },
  more: { color: colors.muted, fontSize: 17, letterSpacing: 2 },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600" as const,
    marginTop: 3,
  },
  scroll: { padding: 16, paddingBottom: 24, gap: 12 },
  messageRow: { width: "100%" as const },
  message: {
    maxWidth: "100%" as const,
    backgroundColor: "transparent",
    borderColor: colors.line,
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  userMessage: {
    backgroundColor: colors.panel,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toolOnly: {
    width: "100%" as const,
    maxWidth: "100%" as const,
    backgroundColor: "transparent",
    borderWidth: 0,
    borderBottomWidth: 1,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 5,
  },
  messageLabel: {
    color: colors.muted,
    fontSize: 12,
    marginBottom: 7,
    textTransform: "uppercase" as const,
    letterSpacing: 0.8,
  },
  toolRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 5,
  },
  toolHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    minHeight: 28,
  },
  toolIcon: {
    width: 18,
    color: colors.muted,
    fontSize: 14,
    textAlign: "center" as const,
  },
  toolName: { color: colors.text, fontSize: 12, fontWeight: "600" as const },
  toolTarget: { color: colors.muted, fontSize: 12, marginTop: 2 },
  chevron: { color: colors.muted, fontSize: 18, paddingHorizontal: 3 },
  toolPreview: {
    color: colors.muted,
    fontSize: 12,
    marginLeft: 26,
    marginTop: 2,
  },
  toolDetail: {
    color: colors.muted,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 15,
    margin: 8,
    padding: 8,
    backgroundColor: colors.bg,
  },
  historyFile: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 9,
    paddingTop: 9,
  },
  fileIcon: { color: colors.muted, fontSize: 18 },
  fileName: { color: colors.text, fontSize: 12 },
  fileMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  notice: {
    borderLeftWidth: 2,
    borderLeftColor: colors.line,
    paddingLeft: 10,
    paddingVertical: 4,
  },
  noticeTitle: { color: colors.text, fontSize: 12 },
  noticeText: { color: colors.muted, fontSize: 12, marginTop: 3 },
  approvalTitle: { color: colors.accent, fontWeight: "700" as const },
  actions: { flexDirection: "row" as const, gap: 9, marginTop: 14 },
  progress: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 12,
  },
  progressTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600" as const,
  },
  progressMeta: { color: colors.muted, fontSize: 12, marginTop: 3 },
  empty: { paddingVertical: 70, alignItems: "center" as const, gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: "700" as const },
  rename: {
    padding: 12,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  composerTop: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 5,
    marginBottom: 5,
  },
  chip: {
    backgroundColor: colors.panel2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  chipText: { color: colors.text, fontSize: 12, maxWidth: 160 },
  composerRow: {
    flexDirection: "row" as const,
    alignItems: "flex-end" as const,
    gap: 7,
  },
  attach: { color: colors.text, fontSize: 18 },
  editor: { flex: 1, maxHeight: 110, paddingVertical: 10 },
};
