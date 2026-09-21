import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../api";
import { useStore } from "../store";
import { colors, styles } from "../ui";
export function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (model: string) => void;
}) {
  const { baseUrl } = useStore();
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const [models, setModels] = useState<Array<{ value: string; name: string }>>(
    [],
  );
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    api(baseUrl)
      .catalog()
      .then((result) => {
        if (active)
          setModels(
            (result.models ?? []).flatMap((model) => {
              const id = model.id;
              if (!id) return [];
              const provider = model.providerID ?? model.provider;
              return [
                {
                  value:
                    provider && !id.startsWith(provider + "/")
                      ? `${provider}/${id}`
                      : id,
                  name: model.name ?? id,
                },
              ];
            }),
          );
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load models.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, baseUrl]);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.ghost, { alignItems: "flex-start" }]}
      >
        <Text numberOfLines={1} style={styles.ghostText}>
          {value || "Choose a model"} ⌄
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.screen}>
          <View
            style={{
              padding: 22,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text style={styles.title}>Models</Text>
            <Pressable onPress={() => setOpen(false)}>
              <Text style={styles.subtitle}>Done</Text>
            </Pressable>
          </View>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Find a model or provider"
            placeholderTextColor={colors.muted}
            style={[styles.input, { marginHorizontal: 22, marginBottom: 16 }]}
          />
          <ScrollView contentContainerStyle={{ padding: 22, gap: 8 }}>
            {loading ? (
              <ActivityIndicator color={colors.muted} />
            ) : error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              models
                .filter((model) =>
                  `${model.name} ${model.value}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((model) => (
                  <Pressable
                    key={model.value}
                    style={styles.card}
                    onPress={() => {
                      onChange(model.value);
                      setOpen(false);
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: 16 }}>
                      {model.name}
                      {value === model.value ? " ✓" : ""}
                    </Text>
                    <Text style={[styles.subtitle, { marginTop: 6 }]}>
                      {model.value}
                    </Text>
                  </Pressable>
                ))
            )}
            {!loading && !error && !models.length && (
              <Text style={styles.subtitle}>
                No models are available yet. Check your computer and provider
                connections in the web app.
              </Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
