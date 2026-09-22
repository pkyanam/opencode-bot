import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  BookOpen,
  Pin,
  Plus,
  Search,
  Share2,
  Trash2,
  X,
} from "lucide-react-native";
import { api } from "../api";
import { colors, styles } from "../ui";
import type { Bot, MemoryItem, MemoryVisibility } from "../types";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HindsightPanel } from "./hindsight-panel";
import { Markdown } from "../markdown";

const visibilityOptions: MemoryVisibility[] = [
  "private",
  "shared",
  "workspace",
];
type Draft = {
  title: string;
  content: string;
  kind: string;
  tags: string;
  visibility: MemoryVisibility;
  sharedBotIds: string[];
  botId: string | null;
};
const blank: Draft = {
  title: "",
  content: "",
  kind: "note",
  tags: "",
  visibility: "private",
  sharedBotIds: [],
  botId: null,
};
const kinds = ["fact", "preference", "decision", "lesson", "procedure", "note"];

export function MemoryRegistry({
  baseUrl,
  bots,
}: {
  baseUrl: string;
  bots: Bot[];
}) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [botFilter, setBotFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [editor, setEditor] = useState<MemoryItem | null | false>(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const requestSequence = useRef(0);
  const load = useCallback(
    async (append = false) => {
      if (!baseUrl) return;
      const sequence = ++requestSequence.current;
      const nextOffset = append ? offset : 0;
      setLoading(true);
      setError("");
      try {
        const next = await api(baseUrl).memories({
          q: query.trim() || undefined,
          botId: botFilter || undefined,
          limit: 100,
          offset: nextOffset,
        });
        if (sequence !== requestSequence.current) return;
        setItems((current) => (append ? [...current, ...next] : next));
        setOffset(nextOffset + next.length);
        setHasMore(next.length === 100);
      } catch (e) {
        if (sequence === requestSequence.current)
          setError(e instanceof Error ? e.message : "Could not load memory.");
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [baseUrl, botFilter, offset, query],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 300 : 0);
    return () => {
      clearTimeout(timer);
      requestSequence.current++;
    };
  }, [baseUrl, botFilter, query]);
  useEffect(() => {
    const refresh = () => {
      if (AppState.currentState === "active") void load();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const timer = setInterval(refresh, 30000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [load]);
  const botName = (id: string | null) =>
    id
      ? (bots.find((bot) => bot.id === id)?.name ?? "Unknown bot")
      : "Archived bot";
  const openCreate = () => {
    setEditorError("");
    setDraft({ ...blank, botId: botFilter || bots[0]?.id || null });
    setEditor(null);
  };
  const openEdit = (item: MemoryItem) => {
    setEditorError("");
    setDraft({
      title: item.title ?? "",
      content: item.content,
      kind: item.kind ?? "note",
      tags: item.tags.join(", "),
      visibility: item.visibility,
      sharedBotIds: item.sharedBotIds,
      botId: item.botId,
    });
    setEditor(item);
  };
  const save = async () => {
    if (!draft.content.trim() || busy || (!editor && !draft.botId)) return;
    setBusy(true);
    setEditorError("");
    try {
      const payload = {
        botId: draft.botId,
        content: draft.content.trim(),
        title: draft.title.trim() || undefined,
        kind: draft.kind.trim() || undefined,
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        visibility: draft.visibility,
        sharedBotIds: draft.sharedBotIds,
      };
      if (editor)
        await api(baseUrl).updateMemory(editor.id, {
          ...payload,
          revision: editor.revision,
        });
      else await api(baseUrl).createMemory(payload);
      setEditor(false);
      await load();
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : "Could not save memory.");
    } finally {
      setBusy(false);
    }
  };
  const remove = (item: MemoryItem) =>
    Alert.alert("Delete memory?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await api(baseUrl).deleteMemory(item.id, item.revision);
            await load();
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Could not delete memory.",
            );
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  const toggleShare = (id: string) =>
    setDraft((current) => ({
      ...current,
      sharedBotIds: current.sharedBotIds.includes(id)
        ? current.sharedBotIds.filter((value) => value !== id)
        : [...current.sharedBotIds, id],
    }));
  return (
    <View style={local.wrap}>
      <HindsightPanel baseUrl={baseUrl} bots={bots} />
      <View style={local.headingRow}>
        <View style={{ flex: 1 }}>
          <Text style={local.title}>Memory</Text>
          <Text style={styles.subtitle}>
            Notes your bots can remember across conversations.
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Add memory"
          disabled={!bots.length}
          onPress={openCreate}
          style={local.iconButton}
        >
          <Plus color={colors.text} size={20} />
        </Pressable>
      </View>
      <View style={local.search}>
        <Search color={colors.muted} size={17} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search memory"
          placeholderTextColor={colors.muted}
          style={local.searchInput}
          autoCapitalize="none"
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={local.filters}
      >
        <Filter
          label="All bots"
          selected={!botFilter}
          onPress={() => setBotFilter("")}
        />
        {bots.map((bot) => (
          <Filter
            key={bot.id}
            label={bot.name}
            selected={botFilter === bot.id}
            onPress={() => setBotFilter(bot.id)}
          />
        ))}
      </ScrollView>
      {error ? (
        <View style={styles.card}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load()}>
            <Text style={local.retry}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
      {loading && !items.length ? (
        <ActivityIndicator color={colors.muted} style={{ marginTop: 36 }} />
      ) : error ? null : items.length ? (
        items.map((item) => (
          <Pressable
            key={item.id}
            style={styles.card}
            onPress={() => openEdit(item)}
          >
            <View style={local.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={local.name}>
                  {item.title || "Untitled memory"}
                </Text>
                <Text style={styles.subtitle}>
                  {botName(item.botId)} · {item.visibility}
                </Text>
              </View>
              {item.pinned ? <Pin color={colors.text} size={16} /> : null}
            </View>
            <View style={local.content}>
              <Markdown value={previewMarkdown(item.content)} compact />
            </View>
            <View style={local.cardBottom}>
              <Text style={styles.subtitle}>
                {item.tags.length
                  ? item.tags.map((tag) => `#${tag}`).join("  ")
                  : item.kind || "note"}
              </Text>
              {item.sharedBotIds.length ? (
                <Share2 color={colors.muted} size={15} />
              ) : null}
              <Pressable
                accessibilityLabel={`Delete ${item.title || "memory"}`}
                onPress={(event) => {
                  event.stopPropagation();
                  remove(item);
                }}
                hitSlop={10}
              >
                <Trash2 color={colors.muted} size={16} />
              </Pressable>
            </View>
          </Pressable>
        ))
      ) : (
        <View style={local.empty}>
          <BookOpen color={colors.muted} size={24} />
          <Text style={local.emptyTitle}>
            {query ? "No matching memories" : "No memories yet"}
          </Text>
          <Text style={styles.subtitle}>
            {query
              ? "Try a different search."
              : "Save a thought here so it is available when your bots need it."}
          </Text>
          {bots.length ? (
            <Pressable
              onPress={openCreate}
              style={[styles.button, { marginTop: 14 }]}
            >
              <Text style={styles.buttonText}>Add memory</Text>
            </Pressable>
          ) : (
            <Text style={styles.subtitle}>
              Add a bot before saving a memory.
            </Text>
          )}
        </View>
      )}
      {hasMore && !loading ? (
        <Pressable onPress={() => void load(true)} style={styles.ghost}>
          <Text style={styles.ghostText}>Load more memories</Text>
        </Pressable>
      ) : null}
      <Modal
        visible={editor !== false}
        animationType="slide"
        onRequestClose={() => setEditor(false)}
      >
        <KeyboardAvoidingView
          style={[local.modal, { paddingTop: insets.top }]}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={local.modalHeader}>
            <Text style={local.modalTitle}>
              {editor ? "Edit memory" : "New memory"}
            </Text>
            <Pressable onPress={() => setEditor(false)} hitSlop={10}>
              <X color={colors.text} size={22} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={local.form}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.label}>Bot</Text>
            {editor ? (
              <Text style={styles.subtitle}>
                {botName(draft.botId)} (author cannot be changed)
              </Text>
            ) : bots.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={local.choiceRow}
              >
                {bots.map((bot) => (
                  <Choice
                    key={bot.id}
                    label={bot.name}
                    selected={draft.botId === bot.id}
                    onPress={() => setDraft({ ...draft, botId: bot.id })}
                  />
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.subtitle}>
                Add a bot before creating memory.
              </Text>
            )}
            <Text style={styles.label}>Title</Text>
            <TextInput
              value={draft.title}
              onChangeText={(title) => setDraft({ ...draft, title })}
              placeholder="A short title"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <Text style={styles.label}>Memory</Text>
            <TextInput
              multiline
              value={draft.content}
              onChangeText={(content) => setDraft({ ...draft, content })}
              placeholder="What should your bot remember?"
              placeholderTextColor={colors.muted}
              style={[styles.input, local.textarea]}
              textAlignVertical="top"
            />
            <Text style={styles.label}>Kind</Text>
            <View style={local.choiceRow}>
              {kinds.map((kind) => (
                <Choice
                  key={kind}
                  label={kind}
                  selected={draft.kind === kind}
                  onPress={() => setDraft({ ...draft, kind })}
                />
              ))}
            </View>
            <Text style={styles.label}>Tags</Text>
            <TextInput
              value={draft.tags}
              onChangeText={(tags) => setDraft({ ...draft, tags })}
              placeholder="project, preference"
              placeholderTextColor={colors.muted}
              style={styles.input}
              autoCapitalize="none"
            />
            <Text style={styles.label}>Visibility</Text>
            <View style={local.choiceRow}>
              {visibilityOptions.map((option) => (
                <Choice
                  key={option}
                  label={option}
                  selected={draft.visibility === option}
                  onPress={() => setDraft({ ...draft, visibility: option })}
                />
              ))}
            </View>
            {draft.visibility === "shared" ? (
              <>
                <Text style={styles.label}>Share with bots</Text>
                <View style={local.shareBox}>
                  {bots.filter((bot) => bot.id !== draft.botId).length ? (
                    bots
                      .filter((bot) => bot.id !== draft.botId)
                      .map((bot) => (
                        <Pressable
                          key={bot.id}
                          onPress={() => toggleShare(bot.id)}
                          style={local.shareRow}
                        >
                          <Text style={local.shareName}>{bot.name}</Text>
                          <Text style={local.check}>
                            {draft.sharedBotIds.includes(bot.id)
                              ? "Selected"
                              : "Select"}
                          </Text>
                        </Pressable>
                      ))
                  ) : (
                    <Text style={styles.subtitle}>
                      No other bots available to share with.
                    </Text>
                  )}
                </View>
              </>
            ) : null}
            {editorError ? (
              <Text style={styles.error}>{editorError}</Text>
            ) : null}
            <Pressable
              disabled={
                busy || !draft.content.trim() || (!editor && !draft.botId)
              }
              onPress={() => void save()}
              style={[
                styles.button,
                {
                  marginTop: 8,
                  opacity:
                    busy || !draft.content.trim() || (!editor && !draft.botId)
                      ? 0.5
                      : 1,
                },
              ]}
            >
              <Text style={styles.buttonText}>
                {busy ? "Saving…" : editor ? "Save changes" : "Create memory"}
              </Text>
            </Pressable>
            {editor ? (
              <Pressable
                disabled={busy}
                onPress={() => {
                  setEditor(false);
                  remove(editor);
                }}
                style={[styles.ghost, { marginTop: 10 }]}
              >
                <Text style={{ color: colors.danger, fontWeight: "600" }}>
                  Delete memory
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
function Filter({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[local.filter, selected && local.filterSelected]}
    >
      <Text
        style={{ color: selected ? colors.text : colors.muted, fontSize: 13 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[local.choice, selected && local.choiceSelected]}
    >
      <Text
        style={{ color: selected ? colors.text : colors.muted, fontSize: 13 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
const local = StyleSheet.create({
  wrap: { gap: 12 },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 5,
  },
  iconButton: { backgroundColor: colors.panel2, borderRadius: 10, padding: 12 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    paddingVertical: 12,
    fontSize: 15,
  },
  filters: { gap: 8, paddingBottom: 2 },
  filter: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 13,
  },
  filterSelected: { backgroundColor: colors.panel2, borderColor: colors.muted },
  cardTop: { flexDirection: "row", gap: 12 },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 5,
  },
  content: { color: colors.text, lineHeight: 21, marginTop: 13, fontSize: 14 },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 15,
  },
  empty: { alignItems: "center", paddingVertical: 58, gap: 10 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "600" },
  retry: { color: colors.text, marginTop: 14 },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "600" },
  form: { padding: 20, gap: 10, paddingBottom: 40 },
  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 5,
  },
  choice: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  choiceSelected: { backgroundColor: colors.panel2, borderColor: colors.muted },
  textarea: { minHeight: 140 },
  shareBox: {
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  shareRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  shareName: { color: colors.text },
  check: { color: colors.muted, fontSize: 13 },
});

function previewMarkdown(value: string): string {
  const normalized = value.replace(/\r/g, "").trim();
  return normalized.length > 900 ? `${normalized.slice(0, 900).trimEnd()}…` : normalized;
}
