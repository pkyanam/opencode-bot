import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { File as ExpoFile, Paths } from "expo-file-system";
import { api, request } from "../api";
import { readToken } from "../storage";
import { colors, styles } from "../ui";
import type { FileArtifact } from "../types";

const TEXT_FILE = /\.(txt|md|json|csv|log|js|ts|tsx|jsx|css|html|yaml|yml|toml|py|sh|xml|sql)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;
const isFolder = (file: FileArtifact) => /dir|folder/i.test(String(file.kind ?? ""));
const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

type Props = { baseUrl: string };

/** A small, server-backed explorer shared by the mobile workspace and future native surfaces. */
export function FilesystemExplorer({ baseUrl }: Props) {
  const [path, setPath] = useState(".");
  const [files, setFiles] = useState<FileArtifact[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ file: FileArtifact; text?: string; uri?: string } | null>(null);
  const [nameDialog, setNameDialog] = useState<{ title: string; value: string; resolve: (value: string | null) => void } | null>(null);
  const previewRequest = useRef(0);
  const refreshRequest = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequest.current;
    setBusy(true);
    setError("");
    try {
      const result = await api(baseUrl).files(path);
      if (requestId === refreshRequest.current) setFiles(Array.isArray(result) ? result : (result.artifacts ?? []));
    } catch (e) {
      if (requestId === refreshRequest.current) setError(e instanceof Error ? e.message : "Could not load files.");
    } finally {
      if (requestId === refreshRequest.current) setBusy(false);
    }
  }, [baseUrl, path]);
  useEffect(() => { void refresh(); return () => { ++refreshRequest.current; ++previewRequest.current; }; }, [refresh]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const prefix = path === "." ? "" : `${path}/`;
    return [...files]
      .filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/"))
      .filter((file) => !query || nameOf(file.path).toLowerCase().includes(query))
      .sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || nameOf(a.path).localeCompare(nameOf(b.path)));
  }, [files, filter, path]);
  const crumbs = path === "." ? [] : path.split("/").filter(Boolean);

  async function open(file: FileArtifact) {
    if (isFolder(file)) { setFilter(""); setPath(file.path); return; }
    const requestId = ++previewRequest.current;
    setPreview({ file });
    if (IMAGE_FILE.test(file.path)) {
      try { const uri = await downloadLocal(baseUrl, file); if (requestId === previewRequest.current) setPreview({ file, uri }); }
      catch (e) { if (requestId === previewRequest.current) setPreview({ file, text: e instanceof Error ? e.message : "Could not download this image." }); }
      return;
    }
    if (!TEXT_FILE.test(file.path) || (file.size ?? 0) > 100_000) return;
    try {
      const text = await api(baseUrl).fileContent(file.path);
      if (requestId === previewRequest.current) setPreview({ file, text: text.slice(0, 100_000) || "Empty file" });
    } catch (e) {
      if (requestId === previewRequest.current) setPreview({ file, text: e instanceof Error ? e.message : "Could not preview this file." });
    }
  }
  async function upload() {
    try {
    const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    setBusy(true);
    setError("");
    try {
      for (const file of result.assets) {
        if ((file.size ?? 0) > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than the 10 MB workspace upload limit.`);
        const target = join(path, file.name);
        if (files.some(item => item.path === target)) throw new Error(`${file.name} already exists. Rename it or choose a different folder before uploading.`);
        await request(baseUrl, `/api/files?path=${encodeURIComponent(target)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new ExpoFile(file.uri),
        });
      }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not upload the file."); }
    finally { setBusy(false); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open the file picker."); }
  }
  async function mkdir() {
    const name = await ask("New folder", "Folder name");
    if (!name) return;
    setBusy(true); setError("");
    try { await request(baseUrl, `/api/files/mkdir?path=${encodeURIComponent(join(path, name))}`, { method: "POST" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create the folder."); }
    finally { setBusy(false); }
  }
  function ask(title: string, message: string): Promise<string | null> {
    return new Promise((resolve) => setNameDialog({ title, value: message, resolve }));
  }
  function rename(file: FileArtifact) {
    void ask("Rename", nameOf(file.path)).then(async (name) => {
      if (!name || name === nameOf(file.path)) return;
      setBusy(true); setError("");
      try { await request(baseUrl, `/api/files/move?from=${encodeURIComponent(file.path)}&to=${encodeURIComponent(join(parent(file.path), name))}`, { method: "POST" }); await refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not rename the file."); }
      finally { setBusy(false); }
    });
  }
  function remove(file: FileArtifact) {
    Alert.alert("Delete item?", `${nameOf(file.path)} will be permanently removed.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteFile(file) },
    ]);
  }
  async function deleteFile(file: FileArtifact) {
    setBusy(true); setError("");
    try { await request(baseUrl, `/api/files?path=${encodeURIComponent(file.path)}`, { method: "DELETE" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete the item."); }
    finally { setBusy(false); }
  }
  async function share(file: FileArtifact) {
    try {
      if (IMAGE_FILE.test(file.path) || !TEXT_FILE.test(file.path) || (file.size ?? 0) > 100_000) {
        const local = await downloadLocal(baseUrl, file);
        if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is unavailable on this device.");
      await Sharing.shareAsync(local, { dialogTitle: nameOf(file.path) });
      } else {
        const text = await api(baseUrl).fileContent(file.path);
        await Share.share({ title: nameOf(file.path), message: text });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not share this file."); }
  }
  async function download(file: FileArtifact) {
    try {
      const uri = await downloadLocal(baseUrl, file);
      if (!(await Sharing.isAvailableAsync())) throw new Error("Saving files is unavailable on this device.");
      await Sharing.shareAsync(uri, { dialogTitle: `Save ${nameOf(file.path)}` });
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not download this file."); }
  }

  return <View style={local.root}>
    <View style={local.toolbar}>
      <TextInput value={filter} onChangeText={setFilter} placeholder="Filter files" placeholderTextColor={colors.muted} style={[styles.input, local.search]} autoCapitalize="none" />
      <Pressable accessibilityLabel="Upload files" style={styles.button} onPress={() => void upload()}><Text style={styles.buttonText}>Upload</Text></Pressable>
    </View>
    <View style={local.actions}>
      <Pressable style={styles.ghost} onPress={() => void mkdir()}><Text style={styles.ghostText}>＋ Folder</Text></Pressable>
      <Pressable style={styles.ghost} onPress={() => void refresh()}><Text style={styles.ghostText}>{busy ? "Loading…" : "Refresh"}</Text></Pressable>
    </View>
    <View style={local.crumbs}>
      <Pressable onPress={() => setPath(".")}><Text style={local.crumb}>Workspace</Text></Pressable>
      {crumbs.map((crumb, index) => <View key={`${crumb}-${index}`} style={local.crumbPart}><Text style={local.slash}>›</Text><Pressable onPress={() => setPath(crumbs.slice(0, index + 1).join("/"))}><Text style={local.crumb}>{crumb}</Text></Pressable></View>)}
    </View>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {path !== "." ? <Pressable style={styles.ghost} onPress={() => setPath(parent(path))}><Text style={styles.ghostText}>‹ Up one folder</Text></Pressable> : null}
    {visible.map((file) => <View key={file.path} style={styles.card}>
      <Pressable style={local.fileMain} onPress={() => void open(file)}><Text style={local.icon}>{isFolder(file) ? "▰" : "□"}</Text><View style={{ flex: 1 }}><Text style={local.name}>{nameOf(file.path)}</Text><Text style={styles.subtitle}>{isFolder(file) ? "Folder" : formatSize(file.size)}</Text></View><Text style={local.chevron}>{isFolder(file) ? "›" : "⌄"}</Text></Pressable>
      {!isFolder(file) ? <View style={local.fileActions}><Pressable onPress={() => void open(file)}><Text style={local.action}>Preview</Text></Pressable><Pressable onPress={() => void download(file)}><Text style={local.action}>Download</Text></Pressable><Pressable onPress={() => void share(file)}><Text style={local.action}>Share</Text></Pressable><Pressable onPress={() => rename(file)}><Text style={local.action}>Rename</Text></Pressable><Pressable onPress={() => remove(file)}><Text style={local.delete}>Delete</Text></Pressable></View> : <View style={local.fileActions}><Pressable onPress={() => rename(file)}><Text style={local.action}>Rename</Text></Pressable><Pressable onPress={() => remove(file)}><Text style={local.delete}>Delete</Text></Pressable></View>}
    </View>)}
    {!busy && !visible.length ? <Text style={styles.subtitle}>{filter ? "No matching files." : "This folder is empty."}</Text> : null}
    <Modal visible={!!preview} animationType="slide" onRequestClose={() => setPreview(null)}>
      <View style={local.modal}><View style={local.modalHead}><Text style={local.modalTitle}>{preview ? nameOf(preview.file.path) : "Preview"}</Text><Pressable onPress={() => setPreview(null)}><Text style={local.action}>Close</Text></Pressable></View>
        {preview?.uri ? <Image accessibilityLabel={nameOf(preview.file.path)} style={local.image} source={{ uri: preview.uri }} /> : <ScrollView><Text selectable style={local.previewText}>{preview?.text ?? "Preview is available for text files up to 100 KB. Use Share or the web workspace for this file."}</Text></ScrollView>}
      </View>
    </Modal>
    <Modal visible={!!nameDialog} transparent animationType="fade" onRequestClose={() => { nameDialog?.resolve(null); setNameDialog(null); }}>
      <View style={local.dialogBackdrop}><View style={local.dialog}><Text style={local.modalTitle}>{nameDialog?.title}</Text><TextInput autoFocus value={nameDialog?.value ?? ""} onChangeText={(value) => setNameDialog((current) => current ? { ...current, value } : current)} placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} autoCapitalize="none" /><View style={local.dialogActions}><Pressable style={styles.ghost} onPress={() => { nameDialog?.resolve(null); setNameDialog(null); }}><Text style={styles.ghostText}>Cancel</Text></Pressable><Pressable style={styles.button} onPress={() => { nameDialog?.resolve(nameDialog.value.trim() || null); setNameDialog(null); }}><Text style={styles.buttonText}>Save</Text></Pressable></View></View></View>
    </Modal>
  </View>;
}
function parent(path: string) { const parts = path.split("/").filter(Boolean); parts.pop(); return parts.join("/") || "."; }
function join(root: string, name: string) { const clean = name.trim().replace(/[\\/]+/g, ""); return root === "." ? clean : `${root}/${clean}`; }
function formatSize(size?: number) { return typeof size === "number" ? `${Math.max(1, Math.ceil(size / 1024))} KB` : "File"; }
async function downloadLocal(baseUrl: string, file: FileArtifact) {
  const auth = await readToken();
  if (!auth) throw new Error("Your session has expired. Pair this device again.");
  const safe = nameOf(file.path).replace(/[^A-Za-z0-9._-]/g, "_");
  const target = new ExpoFile(Paths.cache, `${Date.now()}-${safe}`);
  const downloaded = await ExpoFile.downloadFileAsync(
    `${baseUrl.replace(/\/$/, "")}/api/files/content?path=${encodeURIComponent(file.path)}`,
    target,
    { headers: { Authorization: `Bearer ${auth}` }, idempotent: true },
  );
  return downloaded.uri;
}
const local = StyleSheet.create({ root: { gap: 12 }, toolbar: { flexDirection: "row", gap: 8, alignItems: "center" }, search: { flex: 1, paddingVertical: 11 }, actions: { flexDirection: "row", gap: 8 }, crumbs: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }, crumbPart: { flexDirection: "row", alignItems: "center", gap: 5 }, crumb: { color: colors.text, fontSize: 14, fontWeight: "600" }, slash: { color: colors.muted, fontSize: 18 }, fileMain: { flexDirection: "row", alignItems: "center", gap: 12 }, icon: { color: colors.blue, fontSize: 20, width: 22, textAlign: "center" }, name: { color: colors.text, fontSize: 15, fontWeight: "600", marginBottom: 4 }, chevron: { color: colors.muted, fontSize: 22 }, fileActions: { flexDirection: "row", gap: 17, borderTopWidth: 1, borderTopColor: colors.line, marginTop: 13, paddingTop: 11 }, action: { color: colors.blue, fontSize: 13, fontWeight: "600" }, delete: { color: colors.danger, fontSize: 13, fontWeight: "600" }, modal: { flex: 1, backgroundColor: colors.bg, padding: 22, paddingTop: 64 }, modalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }, modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700", flex: 1 }, previewText: { color: colors.text, lineHeight: 22, fontFamily: "Courier" }, image: { width: "100%", height: 420, resizeMode: "contain" }, dialogBackdrop: { flex: 1, justifyContent: "center", padding: 22, backgroundColor: "rgba(0,0,0,0.65)" }, dialog: { backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 18, gap: 14 }, dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
