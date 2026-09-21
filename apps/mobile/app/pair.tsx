import { parsePairingInput } from "../src/pairing-input";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useStore } from "../src/store";
import { colors, styles } from "../src/ui";
export default function Pair() {
  const store = useStore();
  const params = useLocalSearchParams<{ secret?: string; base?: string }>();
  const [base, setBase] = useState(params.base || store.baseUrl);
  const [secret, setSecret] = useState(params.secret ?? "");
  const [name, setName] = useState("My phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  useEffect(() => {
    if (params.secret) setSecret(params.secret);
    if (params.base) setBase(params.base);
  }, [params.secret, params.base]);
  async function connect() {
    if (!base.trim() || !secret.trim() || !name.trim()) return;
    setBusy(true);
    setError("");
    const url = base.trim().replace(/\/$/, "");
    try {
      await store.pairing(url, secret.trim(), name.trim());
      store.setBaseUrl(url);
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not redeem invitation.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.safe, { justifyContent: "center" }]}>
        <Text style={styles.eyebrow}>PAIR DEVICE</Text>
        <Text style={[styles.title, { marginTop: 9 }]}>
          Connect your workspace.
        </Text>
        <Text style={[styles.subtitle, { marginTop: 12, marginBottom: 28 }]}>
          Open Settings → Devices on an owner device, then paste the invitation
          secret or code here. Invitations are single use.
        </Text>
        <Text style={styles.label}>WORKSPACE URL</Text>
        <TextInput
          value={base}
          onChangeText={setBase}
          autoCapitalize="none"
          keyboardType="url"
          placeholder="https://your-worker.example.com"
          placeholderTextColor={colors.muted}
          style={[styles.input, { marginBottom: 16 }]}
        />
        <Text style={styles.label}>INVITATION CODE OR SECRET</Text>
        {scanning ? (
          <View
            style={{
              height: 190,
              borderRadius: 12,
              overflow: "hidden",
              marginBottom: 12,
            }}
          >
            {permission?.granted ? (
              <CameraView
                style={{ flex: 1 }}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => {
                  try {
                    const invitation = parsePairingInput(data);
                    if (invitation.baseUrl) setBase(invitation.baseUrl);
                    setSecret(invitation.credential);
                    setError("");
                    setScanning(false);
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Invalid invitation.",
                    );
                    setScanning(false);
                  }
                }}
              />
            ) : (
              <Text style={[styles.subtitle, { padding: 14 }]}>
                Camera access is required to scan an invitation.
              </Text>
            )}
          </View>
        ) : null}
        <TextInput
          value={secret}
          onChangeText={setSecret}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste pairing code"
          placeholderTextColor={colors.muted}
          style={[styles.input, { marginBottom: 16 }]}
        />
        <Pressable
          style={[styles.ghost, { marginBottom: 16 }]}
          onPress={async () => {
            if (scanning) {
              setScanning(false);
              return;
            }
            if (!permission?.granted) {
              const result = await requestPermission();
              if (!result.granted) {
                setError(
                  "Allow camera access in Settings, or enter the pairing code.",
                );
                return;
              }
            }
            setScanning(true);
          }}
        >
          <Text style={styles.ghostText}>
            {scanning ? "Close scanner" : "Scan QR invitation"}
          </Text>
        </Pressable>
        <Text style={styles.label}>DEVICE NAME</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholderTextColor={colors.muted}
          style={[styles.input, { marginBottom: 20 }]}
        />
        <Pressable
          style={[styles.button, { opacity: busy ? 0.6 : 1 }]}
          disabled={busy}
          onPress={() => void connect()}
        >
          <Text style={styles.buttonText}>
            {busy ? "Connecting…" : "Connect securely"}
          </Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={{ marginTop: 22, alignItems: "center" }}
          onPress={() => router.back()}
        >
          <Text style={styles.ghostText}>Back</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
