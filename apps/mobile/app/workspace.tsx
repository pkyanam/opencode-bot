import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { api, request } from "../src/api";
import { useStore } from "../src/store";
import { colors, styles } from "../src/ui";
import type { Skill } from "../src/types";
import { FilesystemExplorer } from "../src/components/filesystem-explorer";
import { MemoryRegistry } from "../src/components/memory-registry";

type Section = "skills" | "files" | "memory" | "computer" | "routines";
type Routine = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  intervalMinutes: number;
};
type Computer = {
  state?: string;
  readiness?: string;
  status?: string;
  phase?: string;
  checkpoint?: { createdAt?: string };
  lastCheckpoint?: { createdAt?: string };
};
const sections: Section[] = ["skills", "files", "memory", "computer", "routines"];
export default function Workspace() {
  const params = useLocalSearchParams<{ section?: string }>();
  const { baseUrl, state } = useStore();
  const [section, setSection] = useState<Section>(
    sections.includes(params.section as Section)
      ? (params.section as Section)
      : "skills",
  );
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    if (!baseUrl) {
      setLoading(false);
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const read = <T,>(path: string) =>
      request<T>(baseUrl, path, { signal: controller.signal });
    setLoading(true);
    setError("");
    try {
      if (section === "skills") setSkills(await read<Skill[]>("/api/skills"));
      if (section === "routines")
        setRoutines(await read<Routine[]>("/api/routines"));
      if (section === "computer")
        setComputer(await read<Computer>("/api/computer/status"));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Could not load this part of your workspace.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [baseUrl, section]);
  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);
  async function toggleRoutine(routine: Routine) {
    setSaving(true);
    setError("");
    try {
      await request(
        baseUrl,
        `/api/routines/${encodeURIComponent(routine.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: !routine.enabled }),
        },
      );
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update the routine.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function checkpoint() {
    setSaving(true);
    setError("");
    try {
      setComputer(
        await request<Computer>(baseUrl, "/api/computer/checkpoint", {
          method: "POST",
          timeoutMs: 120000,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save a checkpoint.");
    } finally {
      setSaving(false);
    }
  }
  async function wakeComputer() {
    setSaving(true);
    setError("");
    try {
      setComputer(
        await request<Computer>(baseUrl, "/api/computer/wake", {
          method: "POST",
          timeoutMs: 120000,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not wake the computer.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={local.header}>
        <Pressable
          accessibilityLabel="Back to conversations"
          onPress={() => router.back()}
          hitSlop={12}
        >
          <Text style={local.back}>‹</Text>
        </Pressable>
        <Text style={local.heading}>Workspace</Text>
      </View>
      <View style={local.tabs}>
        {sections.map((item) => (
          <Pressable
            key={item}
            style={[local.tab, section === item && local.selected]}
            onPress={() => {
              setSection(item);
              setExpanded(null);
            }}
          >
            <Text
              style={{
                color: section === item ? colors.text : colors.muted,
                fontSize: 13,
                textTransform: "capitalize",
              }}
            >
              {item}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView
        contentContainerStyle={local.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={load}
            tintColor={colors.muted}
          />
        }
      >
        {error ? (
          <View style={styles.card}>
            <Text style={styles.error}>{error}</Text>
            <Pressable onPress={load} style={{ marginTop: 16 }}>
              <Text style={{ color: colors.text }}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {loading ? (
          <ActivityIndicator color={colors.muted} style={{ marginTop: 40 }} />
        ) : (
          !error && (
            <>
              {section === "skills" &&
                (skills.length ? (
                  skills.map((skill) => (
                    <Pressable
                      key={skill.id}
                      style={styles.card}
                      onPress={() =>
                        setExpanded(expanded === skill.id ? null : skill.id)
                      }
                    >
                      <Text style={local.name}>{skill.name}</Text>
                      <Text style={styles.subtitle}>
                        {skill.description || "Workspace skill"}
                      </Text>
                      {expanded === skill.id && (
                        <Text selectable style={local.body}>
                          {skill.instructions}
                        </Text>
                      )}
                    </Pressable>
                  ))
                ) : (
                  <Empty
                    title="No skills yet"
                    detail="Skills give your bots reusable instructions. Add them from the web workspace, then review them here."
                  />
                ))}
              {section === "files" && <FilesystemExplorer baseUrl={baseUrl} />}
              {section === "memory" && <MemoryRegistry baseUrl={baseUrl} bots={state?.bots ?? []} />}
              {section === "computer" && (
                <View style={styles.card}>
                  <Text style={local.name}>Shared computer</Text>
                  {String(computer?.state ?? computer?.readiness ?? "").toLowerCase() === "sleeping" ? (
                    <>
                      <Text style={styles.subtitle}>Sleeping to save resources.</Text>
                      <Text style={local.body}>Wake it when you need to inspect the desktop or run a task.</Text>
                      <Pressable
                        style={[styles.button, { marginTop: 16, opacity: saving ? 0.5 : 1 }]}
                        disabled={saving}
                        onPress={() => void wakeComputer()}
                      >
                        <Text style={styles.buttonText}>{saving ? "Waking…" : "Wake computer"}</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Text style={styles.subtitle}>
                      {computer?.state ?? computer?.readiness ?? computer?.status ?? computer?.phase ?? "Status unavailable"}
                    </Text>
                  )}
                  <Text style={local.body}>
                    Your bots continue working here when you close the app.
                  </Text>
                  {(computer?.checkpoint?.createdAt ??
                    computer?.lastCheckpoint?.createdAt) && (
                    <Text style={styles.subtitle}>
                      Last saved{" "}
                      {new Date(
                        (computer?.checkpoint?.createdAt ??
                          computer?.lastCheckpoint?.createdAt)!,
                      ).toLocaleString()}
                    </Text>
                  )}
                  <Pressable
                    style={[
                      styles.ghost,
                      { marginTop: 20, opacity: saving ? 0.5 : 1 },
                    ]}
                    disabled={saving || String(computer?.state ?? computer?.readiness ?? "").toLowerCase() === "sleeping"}
                    onPress={checkpoint}
                  >
                    <Text style={styles.ghostText}>
                      {saving ? "Saving…" : "Save checkpoint"}
                    </Text>
                  </Pressable>
                  <Text style={[styles.subtitle, { marginTop: 16 }]}>
                    Live computer viewing is available in the web app.
                  </Text>
                </View>
              )}
              {section === "routines" &&
                (routines.length ? (
                  routines.map((routine) => (
                    <View style={styles.card} key={routine.id}>
                      <View style={local.row}>
                        <Text style={[local.name, { flex: 1 }]}>
                          {routine.title}
                        </Text>
                        <Switch
                          value={routine.enabled}
                          disabled={saving}
                          onValueChange={() => toggleRoutine(routine)}
                          trackColor={{
                            false: colors.line,
                            true: colors.muted,
                          }}
                        />
                      </View>
                      <Text style={styles.subtitle}>
                        Every {routine.intervalMinutes} minutes
                      </Text>
                      <Text style={local.body}>{routine.prompt}</Text>
                    </View>
                  ))
                ) : (
                  <Empty
                    title="No routines yet"
                    detail="Scheduled tasks from your web workspace will appear here. You can pause or resume them from your phone."
                  />
                ))}
            </>
          )
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={{ paddingVertical: 52, gap: 12 }}>
      <Text style={local.heading}>{title}</Text>
      <Text style={styles.subtitle}>{detail}</Text>
    </View>
  );
}
const local = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { color: colors.text, fontSize: 30 },
  heading: { color: colors.text, fontSize: 21, fontWeight: "600" },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  selected: { borderBottomColor: colors.text },
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 7,
  },
  body: { color: colors.text, fontSize: 14, lineHeight: 22, marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 16 },
});
