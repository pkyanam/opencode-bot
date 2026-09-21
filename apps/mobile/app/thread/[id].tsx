import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { api, ApiError } from "../../src/api";
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
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "completed",
  "error",
]);
function eventText(e: RunEvent) {
  return (
    e.message ?? e.content ?? (typeof e.data === "string" ? e.data : "") ?? ""
  );
}
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const thread = store.state?.threads.find((item) => item.id === id);
  const client = useMemo(() => api(store.baseUrl), [store.baseUrl]);
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [transcript, state] = await Promise.all([
        client.messages(id),
        client.state(),
      ]);
      const threadRuns = (state.runs ?? []).filter(
        (run) => run.threadId === id,
      );
      const refreshed = await Promise.all(
        threadRuns
          .filter((run) => !terminal.has(run.status))
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
      const byId = new Map(refreshed.map((run) => [run.id, run]));
      setMessages(
        transcript.messages ??
          state.messages?.[id] ??
          state.threadMessages?.[id] ??
          [],
      );
      setRuns(threadRuns.map((run) => byId.get(run.id) ?? run));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load conversation.");
    }
  }, [client, id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const active = runs.some((run) => !terminal.has(run.status));
    if (!active) return;
    const timer = setInterval(() => {
      void load();
    }, 2500);
    return () => clearInterval(timer);
  }, [runs, load]);
  async function pickAttachment() {
    if (attachments.length >= 8) return;
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    if (file.size && file.size > 10 * 1024 * 1024) {
      setError("Attachments must be 10 MiB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const uploaded = await client.upload({
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
      });
      setAttachments((current) => [...current, uploaded.attachment]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload attachment.");
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if ((!draft.trim() && !attachments.length) || busy || !id) return;
    const prompt = draft.trim();
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
      setDraft(prompt);
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
    try {
      await client.approve(run.id, approval, decision);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update approval.");
    }
  }
  const activity = runs
    .flatMap((run) => (run.events ?? []).map((event) => ({ run, event })))
    .slice(-30);
  const approval = runs
    .map((run) => ({
      run,
      approval: run.pendingApproval ?? run.approval ?? run.approvalRequest,
    }))
    .find((item) => item.approval);
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={{
          paddingTop: 58,
          paddingHorizontal: 20,
          paddingBottom: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: colors.accent, fontSize: 25 }}>‹</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>THREAD</Text>
          <Text
            numberOfLines={1}
            style={{
              color: colors.text,
              fontSize: 20,
              fontWeight: "700",
              marginTop: 4,
            }}
          >
            {thread?.title ?? "Conversation"}
          </Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 12 }}
      >
        <View
          style={{ height: 1, backgroundColor: colors.line, marginBottom: 2 }}
        />
        {messages.map((message, index) => (
          <View
            key={message.id ?? index}
            style={{
              alignItems: message.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <View
              style={[
                styles.card,
                {
                  maxWidth: "92%",
                  backgroundColor:
                    message.role === "user" ? "#29321e" : colors.panel2,
                },
              ]}
            >
              {message.content ? (
                <Markdown value={message.content} />
              ) : message.error ? (
                <Markdown value={`Error: ${message.error}`} />
              ) : null}
              {message.parts
                ?.filter((part) => part.type === "tool")
                .map((part) => (
                  <View
                    key={part.id}
                    style={{
                      borderTopWidth: 1,
                      borderTopColor: colors.line,
                      marginTop: 10,
                      paddingTop: 8,
                    }}
                  >
                    <Text style={{ color: colors.blue, fontSize: 12 }}>
                      {part.name} · {part.status}
                    </Text>
                    {part.output ? (
                      <Markdown value={part.output} compact />
                    ) : null}
                  </View>
                ))}
            </View>
          </View>
        ))}
        {activity.map(({ run, event }, index) => (
          <View
            key={`${run.id}-${event.id ?? index}`}
            style={{ paddingVertical: 6 }}
          >
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              {eventText(event) || event.type || "Task activity"}
            </Text>
          </View>
        ))}
        {approval ? (
          <View
            style={[styles.card, { borderColor: colors.accent, marginTop: 6 }]}
          >
            <Text style={{ color: colors.accent, fontWeight: "700" }}>
              Approval required
            </Text>
            <Text style={[styles.subtitle, { marginTop: 7 }]}>
              {approval.approval?.description ??
                approval.approval?.action ??
                "The task is waiting for your approval."}
            </Text>
            {approval.approval?.command ? (
              <Text
                style={{
                  color: colors.text,
                  marginTop: 8,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                }}
              >
                {approval.approval.command}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <Pressable
                style={[styles.button, { flex: 1 }]}
                onPress={() =>
                  void decide(approval.run, approval.approval!, "approve")
                }
              >
                <Text style={styles.buttonText}>Approve</Text>
              </Pressable>
              <Pressable
                style={[styles.ghost, { flex: 1 }]}
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
          .filter((run) => !terminal.has(run.status))
          .map((run) => (
            <View
              key={run.id}
              style={[
                styles.card,
                {
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                },
              ]}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 9 }}
              >
                <ActivityIndicator color={colors.accent} size="small" />
                <Text style={styles.subtitle}>
                  {run.status.replace("_", " ")}
                </Text>
              </View>
              <Pressable style={styles.ghost} onPress={() => void cancel(run)}>
                <Text style={styles.ghostText}>Stop</Text>
              </Pressable>
            </View>
          ))}
        {error ? (
          <Text style={styles.error}>
            {error}
            {error.includes("401") ? " Pair this device again." : ""}
          </Text>
        ) : null}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: Platform.OS === "ios" ? 24 : 12,
          borderTopWidth: 1,
          borderTopColor: colors.line,
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 9,
        }}
      >
        {attachments.length > 0 ? (
          <View
            style={{
              position: "absolute",
              bottom: 62,
              left: 16,
              right: 16,
              flexDirection: "row",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            {attachments.map((file) => (
              <Pressable
                key={file.id}
                onPress={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== file.id),
                  )
                }
                style={{
                  backgroundColor: colors.panel2,
                  borderColor: colors.line,
                  borderWidth: 1,
                  borderRadius: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{ color: colors.text, maxWidth: 180, fontSize: 12 }}
                >
                  {file.name} ×
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable
          style={styles.ghost}
          disabled={busy || attachments.length >= 8}
          onPress={() => void pickAttachment()}
        >
          <Text style={styles.ghostText}>＋</Text>
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="Ask your bot to inspect, build, or explain…"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            { flex: 1, maxHeight: 110, paddingVertical: 11 },
          ]}
        />
        <Pressable
          style={[
            styles.button,
            {
              paddingHorizontal: 15,
              opacity: (!draft.trim() && !attachments.length) || busy ? 0.5 : 1,
            },
          ]}
          disabled={(!draft.trim() && !attachments.length) || busy}
          onPress={() => void send()}
        >
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
