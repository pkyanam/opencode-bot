import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { useStore } from "../src/store";
import { api } from "../src/api";
import { parsePairingInput } from "../src/pairing-input";
import { colors, styles } from "../src/ui";
import { ModelPicker } from "../src/components/model-picker";
import type { Bot } from "../src/types";
export default function Home() {
  const store = useStore();
  const insets = useSafeAreaInsets();
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullRefresh = async () => {
    setPullRefreshing(true);
    try {
      await store.refresh();
    } finally {
      setPullRefreshing(false);
    }
  };
  const [view, setView] = useState<"chats" | "bots" | "settings">("chats");
  const [form, setForm] = useState<"thread" | "bot" | null>(null);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selectedBot, setSelectedBot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bots = store.state?.bots ?? [],
    threads = store.state?.threads ?? [];
  const navItems = [
    { key: "chats" as const, label: "Chats", symbol: "◌" },
    { key: "bots" as const, label: "Bots", symbol: "✦" },
    { key: "workspace" as const, label: "Workspace", symbol: "▦" },
    { key: "settings" as const, label: "Settings", symbol: "⚙" },
  ];
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      try {
        const invitation = parsePairingInput(url);
        router.push({
          pathname: "/pair",
          params: {
            secret: invitation.credential,
            base: invitation.baseUrl ?? "",
          },
        });
      } catch {}
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
  function openBot(bot?: Bot) {
    setEditing(bot ?? null);
    setName(bot?.name ?? "");
    setModel(bot?.model ?? "");
    setInstructions(bot?.instructions ?? "");
    setError("");
    setForm("bot");
  }
  function openThread(bot?: Bot) {
    if (!bots.length) {
      openBot();
      return;
    }
    setSelectedBot(bot?.id ?? bots[0].id);
    setTitle("");
    setError("");
    setForm("thread");
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (form === "bot") {
        const payload = {
          name: name.trim(),
          model: model.trim(),
          instructions: instructions.trim(),
        };
        if (editing) await api(store.baseUrl).updateBot(editing.id, payload);
        else await api(store.baseUrl).createBot(payload);
        setView("bots");
        setForm(null);
        await store.refresh();
      } else {
        const thread = await api(store.baseUrl).createThread(
          selectedBot,
          title.trim() || "New conversation",
        );
        setForm(null);
        await store.refresh();
        router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function removeBot() {
    if (!editing) return;
    const bot = editing;
    Alert.alert(
      `Delete ${bot.name}?`,
      "This removes the bot and its conversations from the workspace.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await api(store.baseUrl).deleteBot(bot.id);
              setForm(null);
              await store.refresh();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not delete bot.",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }
  const wordmark = (
    <Image
      accessibilityLabel="opencode bot"
      source={require("../assets/wordmark.png")}
      style={{ width: 164, height: 28, resizeMode: "cover" }}
    />
  );
  if (store.loading && !store.state)
    return (
      <SafeAreaView style={styles.screen}>
        <View style={{ padding: 24 }}>{wordmark}</View>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            gap: 16,
          }}
        >
          <ActivityIndicator color={colors.muted} />
          <Text style={styles.subtitle}>Opening your workspace…</Text>
        </View>
      </SafeAreaView>
    );
  if (!store.connected)
    return (
      <SafeAreaView style={styles.screen}>
        <View style={{ padding: 24 }}>{wordmark}</View>
        <View
          style={{ flex: 1, justifyContent: "center", padding: 28, gap: 18 }}
        >
          <Text style={styles.title}>Your workspace, with you.</Text>
          <Text style={styles.subtitle}>
            Connect to your bots, conversations, and shared computer.
          </Text>
          <Pressable style={styles.button} onPress={() => router.push("/pair")}>
            <Text style={styles.buttonText}>Pair this phone</Text>
          </Pressable>
          {store.error ? <Text style={styles.error}>{store.error}</Text> : null}
        </View>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View
        style={{
          paddingHorizontal: 22,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
        }}
      >
        {wordmark}
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 22, paddingBottom: 32, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            tintColor={colors.muted}
            refreshing={pullRefreshing}
            onRefresh={() => void pullRefresh()}
          />
        }
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 24,
          }}
        >
          <Text style={styles.title}>
            {view === "chats"
              ? "Conversations"
              : view === "bots"
                ? "Your bots"
                : "Settings"}
          </Text>
          {view !== "settings" && (
            <Pressable
              accessibilityLabel={
                view === "chats" ? "New conversation" : "Create bot"
              }
              accessibilityRole="button"
              accessibilityHint={
                view === "chats"
                  ? "Choose a bot and start a conversation"
                  : "Add a bot to this workspace"
              }
              onPress={() => (view === "chats" ? openThread() : openBot())}
              hitSlop={12}
            >
              <Text style={{ color: colors.text, fontSize: 26 }}>＋</Text>
            </Pressable>
          )}
        </View>
        {store.error ? (
          <View style={[styles.card, { marginBottom: 20 }]}>
            <Text style={styles.error}>{store.error}</Text>
            <Pressable
              style={{ marginTop: 12 }}
              accessibilityRole="button"
              onPress={() => void store.refresh()}
            >
              <Text style={{ color: colors.text }}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {view === "chats" &&
          (threads.length ? (
            <View style={{ gap: 10 }}>
              {threads.map((thread) => (
                <Pressable
                  key={thread.id}
                  style={styles.cardPressable}
                  accessibilityRole="button"
                  accessibilityLabel={`Open conversation ${thread.title}`}
                  onPress={() =>
                    router.push({
                      pathname: "/thread/[id]",
                      params: { id: thread.id },
                    })
                  }
                >
                  <Text
                    numberOfLines={2}
                    style={{
                      color: colors.text,
                      fontSize: 16,
                      fontWeight: "600",
                      lineHeight: 23,
                    }}
                  >
                    {thread.title}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.subtitle, { marginTop: 7 }]}
                  >
                    {bots.find((bot) => bot.id === thread.botId)?.name ?? "Bot"}
                    {thread.updatedAt
                      ? ` · ${new Date(thread.updatedAt).toLocaleDateString()}`
                      : ""}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : (
            !store.error && (
              <View
                style={{
                  flex: 1,
                  justifyContent: "center",
                  paddingBottom: 24,
                  gap: 16,
                }}
              >
                <Text style={[styles.title, { fontSize: 26 }]}>
                  {bots.length ? "Start something." : "Meet your first bot."}
                </Text>
                <Text style={styles.subtitle}>
                  {bots.length
                    ? "Choose a bot and give it a task. Each conversation keeps its own history."
                    : "Give your bot a name, a model, and a role. You can change these anytime."}
                </Text>
                <Pressable
                  style={[
                    styles.button,
                    { alignSelf: "flex-start", marginTop: 8 },
                  ]}
                  onPress={() => openThread()}
                >
                  <Text style={styles.buttonText}>
                    {bots.length ? "New conversation" : "Create a bot"}
                  </Text>
                </Pressable>
              </View>
            )
          ))}
        {view === "bots" && (
          <View style={{ gap: 12 }}>
            {bots.map((bot) => (
              <View key={bot.id} style={styles.card}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                  }}
                >
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 8,
                      backgroundColor: colors.panel2,
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: colors.text, fontWeight: "600" }}>
                      {bot.name.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <Pressable
                    style={{ flex: 1 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Start a conversation with ${bot.name}`}
                    onPress={() => openThread(bot)}
                  >
                    <Text
                      style={{
                        color: colors.text,
                        fontSize: 17,
                        fontWeight: "600",
                      }}
                    >
                      {bot.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.subtitle, { marginTop: 4 }]}
                    >
                      {bot.model || "Default model"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Edit ${bot.name}`}
                    accessibilityRole="button"
                    accessibilityHint="Open bot settings"
                    hitSlop={12}
                    onPress={() => openBot(bot)}
                  >
                    <Text style={{ color: colors.muted, fontSize: 24 }}>⋯</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {!bots.length && (
              <View style={[styles.card, { paddingVertical: 24, gap: 14 }]}>
                <Text style={styles.title}>No bots yet</Text>
                <Text style={styles.subtitle}>
                  Create one with a name, model, and role. You can edit it
                  whenever you like.
                </Text>
                <Pressable
                  style={styles.button}
                  onPress={() => openBot()}
                  accessibilityRole="button"
                >
                  <Text style={styles.buttonText}>Create a bot</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        {view === "settings" && (
          <View style={{ gap: 16 }}>
            <View style={styles.card}>
              <Text style={styles.label}>WORKSPACE</Text>
              <Text
                selectable
                style={[styles.subtitle, { color: colors.text }]}
              >
                {store.baseUrl}
              </Text>
              <Text style={[styles.subtitle, { marginTop: 14 }]}>
                This phone has its own connection. You can revoke it from
                Devices in the web app.
              </Text>
            </View>
            <Pressable
              style={styles.card}
              accessibilityRole="button"
              accessibilityLabel="Open skills, files, and computer workspace"
              onPress={() => router.push("/workspace")}
            >
              <Text style={{ color: colors.text, fontSize: 16 }}>
                Skills, files & computer
              </Text>
              <Text style={[styles.subtitle, { marginTop: 6 }]}>
                Browse your workspace and manage routines.
              </Text>
            </Pressable>
            <Pressable
              style={styles.ghost}
              onPress={() =>
                Alert.alert(
                  "Disconnect this phone?",
                  "Your bots and conversations will stay in the workspace.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Disconnect",
                      onPress: () => void store.disconnect(),
                    },
                  ],
                )
              }
            >
              <Text style={styles.ghostText}>Disconnect</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: colors.line,
          paddingTop: 14,
          paddingBottom: Math.max(14, insets.bottom),
          backgroundColor: colors.bg,
        }}
      >
        {navItems.map((item) => (
          <Pressable
            key={item.key}
            style={styles.navItem}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: view === item.key }}
            onPress={() =>
              item.key === "workspace"
                ? router.push("/workspace")
                : setView(item.key)
            }
          >
            <Text
              style={{
                fontSize: 16,
                color: view === item.key ? colors.text : colors.muted,
              }}
            >
              {item.symbol}
            </Text>
            <Text
              style={[
                styles.navLabel,
                { color: view === item.key ? colors.text : colors.muted },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Modal
        visible={!!form}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => !busy && setForm(null)}
      >
        <SafeAreaView style={styles.screen}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              padding: 22,
            }}
          >
            <Text style={[styles.title, { fontSize: 21 }]}>
              {form === "thread"
                ? "New conversation"
                : editing
                  ? "Bot settings"
                  : "Create a bot"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              disabled={busy}
              onPress={() => setForm(null)}
            >
              <Text style={styles.subtitle}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 22, gap: 14 }}
          >
            {form === "thread" ? (
              <>
                <Text style={styles.label}>BOT</Text>
                <View style={{ gap: 8 }}>
                  {bots.map((bot) => (
                    <Pressable
                      key={bot.id}
                      style={[
                        styles.card,
                        {
                          borderColor:
                            selectedBot === bot.id ? colors.text : colors.line,
                        },
                      ]}
                      onPress={() => setSelectedBot(bot.id)}
                    >
                      <Text style={{ color: colors.text }}>
                        {bot.name}
                        {selectedBot === bot.id ? "  ✓" : ""}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[styles.label, { marginTop: 12 }]}>
                  TITLE · OPTIONAL
                </Text>
                <TextInput
                  accessibilityLabel="Conversation title"
                  value={title}
                  onChangeText={setTitle}
                  style={styles.input}
                  placeholder="New conversation"
                  placeholderTextColor={colors.muted}
                />
              </>
            ) : (
              <>
                <Text style={styles.label}>NAME</Text>
                <TextInput
                  accessibilityLabel="Bot name"
                  value={name}
                  onChangeText={setName}
                  style={styles.input}
                  placeholder="Your bot’s name"
                  placeholderTextColor={colors.muted}
                />
                <Text style={styles.label}>MODEL</Text>
                <ModelPicker value={model} onChange={setModel} />
                <Text style={styles.label}>INSTRUCTIONS</Text>
                <TextInput
                  accessibilityLabel="Bot instructions"
                  value={instructions}
                  onChangeText={setInstructions}
                  style={[
                    styles.input,
                    { minHeight: 130, textAlignVertical: "top" },
                  ]}
                  multiline
                  placeholder="What should this bot do?"
                  placeholderTextColor={colors.muted}
                />
              </>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              style={[
                styles.button,
                {
                  marginTop: 8,
                  opacity:
                    busy || (form === "bot" ? !name.trim() : !selectedBot)
                      ? 0.5
                      : 1,
                },
              ]}
              disabled={busy || (form === "bot" ? !name.trim() : !selectedBot)}
              onPress={save}
            >
              <Text style={styles.buttonText}>
                {busy
                  ? "Saving…"
                  : form === "thread"
                    ? "Start conversation"
                    : editing
                      ? "Save changes"
                      : "Create bot"}
              </Text>
            </Pressable>
            {form === "bot" && editing && (
              <Pressable
                disabled={busy}
                style={{ paddingVertical: 18, alignItems: "center" }}
                onPress={removeBot}
              >
                <Text style={{ color: colors.danger }}>Delete bot</Text>
              </Pressable>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
