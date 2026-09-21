import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import { useStore } from "../src/store";
import { parsePairingInput } from "../src/pairing-input";
import { colors, styles } from "../src/ui";
import type { Thread } from "../src/types";
export default function Home() {
  const store = useStore();
  const [title, setTitle] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
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
      } catch {
        // Ignore unrelated or malformed links without disturbing an active connection.
      }
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
  if (!store.connected)
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Text style={styles.eyebrow}>OPENCODE BOT / MOBILE</Text>
        <Text style={[styles.title, { marginTop: 10 }]}>
          A quiet window into your workspace.
        </Text>
        <Text style={[styles.subtitle, { marginTop: 14, marginBottom: 28 }]}>
          Pair this phone with an invitation from Settings → Devices. Your
          device token stays in encrypted storage.
        </Text>
        <Pressable style={styles.button} onPress={() => router.push("/pair")}>
          <Text style={styles.buttonText}>Connect a device</Text>
        </Pressable>
        {store.error ? <Text style={styles.error}>{store.error}</Text> : null}
      </ScrollView>
    );
  const threads = store.state?.threads ?? [];
  async function create() {
    const bot = store.state?.bots[0];
    if (!bot || !title.trim()) return;
    setBusy(true);
    try {
      const thread = await (
        await import("../src/api")
      )
        .api(store.baseUrl)
        .createThread(bot.id, title.trim());
      setTitle("");
      setShowNew(false);
      await store.refresh();
      router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
    } catch {
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: 20, paddingTop: 62 }}
      refreshControl={
        <RefreshControl
          tintColor={colors.accent}
          refreshing={false}
          onRefresh={() => void store.refresh()}
        />
      }
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <View>
          <Text style={styles.eyebrow}>WORKSPACE</Text>
          <Text style={[styles.title, { marginTop: 7 }]}>Conversations</Text>
        </View>
        <Pressable style={styles.ghost} onPress={() => void store.disconnect()}>
          <Text style={styles.ghostText}>Disconnect</Text>
        </Pressable>
      </View>
      <View
        style={{
          marginTop: 28,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={styles.subtitle}>
          {store.state?.bots.length ?? 0} bots · {threads.length} threads
        </Text>
        <Pressable onPress={() => setShowNew(!showNew)}>
          <Text style={{ color: colors.accent, fontWeight: "700" }}>
            + New thread
          </Text>
        </Pressable>
      </View>
      {showNew ? (
        <View style={[styles.card, { marginTop: 14 }]}>
          <Text style={styles.label}>THREAD TITLE</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="What are you working on?"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoFocus
          />
          <Pressable
            style={[styles.button, { marginTop: 12, opacity: busy ? 0.6 : 1 }]}
            disabled={busy}
            onPress={() => void create()}
          >
            <Text style={styles.buttonText}>
              {busy ? "Creating…" : "Create thread"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ marginTop: 24, gap: 10 }}>
        {threads.map((thread: Thread) => (
          <Pressable
            key={thread.id}
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/thread/[id]",
                params: { id: thread.id },
              })
            }
          >
            <Text
              style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}
            >
              {thread.title}
            </Text>
            <Text style={[styles.subtitle, { marginTop: 6 }]}>
              {thread.updatedAt
                ? new Date(thread.updatedAt).toLocaleDateString()
                : "Ready for a prompt"}
            </Text>
          </Pressable>
        ))}
      </View>
      {!threads.length ? (
        <View style={{ paddingTop: 44, alignItems: "center" }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[styles.subtitle, { marginTop: 12 }]}>
            Loading your workspace…
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
