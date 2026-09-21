import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Download,
  File,
  Folder,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Search,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderPlus,
  X,
} from "lucide-react";
import { api, type FileArtifact } from "../api";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";

const isText = (path: string) =>
  /\.(txt|md|mdx|json|js|jsx|ts|tsx|css|html|yml|yaml|xml|sh|py|toml|log)$/i.test(
    path,
  );
const fmtSize = (value = 0) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${Math.ceil(value / 1024)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
export function FilesExplorer() {
  const [path, setPath] = useState(".");
  const [items, setItems] = useState<FileArtifact[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "modified">("name");
  const [selected, setSelected] = useState<FileArtifact | null>(null);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [imagePreview, setImagePreview] = useState("");
  const [action, setAction] = useState<"mkdir" | "rename" | "delete" | null>(
    null,
  );
  const [actionName, setActionName] = useState("");
  const loadController = useRef<AbortController | undefined>(undefined);
  const previewController = useRef<AbortController | undefined>(undefined);
  const load = async (nextPath = path) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      setLoading(true);
      const result = await api.files(nextPath, controller.signal);
      if (controller.signal.aborted) return;
      setItems(Array.isArray(result) ? result : (result.artifacts ?? []));
      setError("");
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not load files.");
    } finally {
      if (controller.signal.aborted) return;
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [path]);
  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    },
    [imagePreview],
  );
  const current =
    path === "." ? "" : `${path.replace(/^\.\//, "").replace(/\/$/, "")}/`;
  const children = useMemo(() => {
    const seen = new Set<string>();
    return items
      .filter((item) => {
        const relative = item.path.startsWith(current)
          ? item.path.slice(current.length)
          : "";
        if (!relative || relative.includes("/")) return false;
        if (seen.has(relative)) return false;
        seen.add(relative);
        return !query || relative.toLowerCase().includes(query.toLowerCase());
      })
      .sort((a, b) =>
        sort === "modified"
          ? String(b.modifiedAt).localeCompare(String(a.modifiedAt))
          : a.path.localeCompare(b.path),
      );
  }, [items, current, query, sort]);
  const open = async (item: FileArtifact) => {
    previewController.current?.abort();
    setImagePreview(""); setPreview("");
    if (item.kind === "directory") {
      setSelected(null); setPath(item.path); setQuery(""); return;
    }
    setSelected(item);
    const controller = new AbortController();
    previewController.current = controller;
    if ((item.size ?? 0) > 5 * 1024 * 1024) { setPreview("This file is too large to preview. Use Download to open it locally."); return; }
    try {
      if (isText(item.path)) {
        const text = await api.fileContent(item.path, controller.signal);
        if (!controller.signal.aborted) setPreview(text.length > 200_000 ? text.slice(0, 200_000) + "\n… Preview truncated. Download for the complete file." : text || "Empty file");
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(item.path)) {
        const blob = await api.fileDownload(item.path, controller.signal);
        if (!controller.signal.aborted) setImagePreview(URL.createObjectURL(blob));
      }
    } catch (e) {
      if (!controller.signal.aborted) setPreview(e instanceof Error ? e.message : "Preview unavailable.");
    }
  };
  useEffect(() => () => previewController.current?.abort(), []);
  const download = async (item: FileArtifact) => {
    try {
      const blob = await api.fileDownload(item.path);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = item.path.split("/").at(-1) || "download";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download file.");
    }
  };
  const upload = async (file: File) => {
    const target = current + file.name.replace(/[\\/]/g, "_");
    if (file.size > 10 * 1024 * 1024) { setError("Files must be 10 MiB or smaller."); return; }
    if (items.some(item => item.path === target) && !window.confirm(`Replace ${target}? The existing file will be overwritten.`)) return;
    try {
      setUploading(true);
      await api.fileUpload(target, await file.arrayBuffer(), file.type);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload file.");
    } finally {
      setUploading(false);
    }
  };
  const confirmAction = async () => {
    const name = actionName.trim();
    if (!action || (action !== "delete" && !name) || uploading) return;
    setUploading(true);
    try {
      if (action === "mkdir") await api.fileMkdir(current + name);
      else if (action === "rename" && selected) {
        const destination = `${current}${name}`;
        await api.fileMove(selected.path, destination);
        setSelected({ ...selected, path: destination });
      }
      else if (action === "delete" && selected) {
        await api.fileDelete(selected.path);
        setSelected(null);
      }
      setAction(null);
      setActionName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update files.");
    } finally { setUploading(false); }
  };
  const crumbs = path === "." ? [] : path.split("/");
  return (
    <main className="main workspace-surface files-explorer">
      <div className="surface-head">
        <div>
          <div className="eyebrow">SHARED COMPUTER</div>
          <h1>Files</h1>
          <p>Browse and download artifacts created by your bots.</p>
        </div>
        <div className="files-actions">
          <Button
            variant="outline"
            onClick={() => {
              setAction("mkdir");
              setActionName("");
            }}
          >
            <FolderPlus size={14} /> New folder
          </Button>
          <label className="file-upload-btn">
            <Upload size={14} />
            {uploading ? "Uploading…" : "Upload"}
            <input
              type="file"
              hidden
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void upload(file);
              }}
            />
          </label>
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>
      <div className="files-breadcrumbs">
        <button onClick={() => setPath(".")}>
          <HardDrive size={14} /> workspace
        </button>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb}-${index}`}>
            <ChevronRight size={13} />
            <button
              onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
            >
              {crumb}
            </button>
          </span>
        ))}
      </div>
      <div className="files-toolbar">
        <div className="files-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this folder"
          />
        </div>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          aria-label="Sort files"
        >
          <option value="name">Name</option>
          <option value="modified">Recently changed</option>
        </select>
      </div>
      {error && (
        <div className="inline-error">
          {error}
          <button onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="file-list">
        {loading ? (
          <div className="surface-empty">
            <LoaderCircle size={20} className="spin" />
            <p>Reading workspace…</p>
          </div>
        ) : children.length ? (
          children.map((item) => (
            <div
              role="button"
              tabIndex={0}
              className="file-row"
              key={item.path}
              onClick={() => void open(item)}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void open(item); }
              }}
            >
              <span className="file-icon">
                {item.kind === "directory" ? (
                  <Folder size={17} />
                ) : (
                  <File size={17} />
                )}
              </span>
              <span className="file-name">
                <strong>{item.path.slice(current.length)}</strong>
                <small>
                  {item.kind === "directory"
                    ? "Folder"
                    : `${fmtSize(item.size)} · ${new Date(item.modifiedAt).toLocaleDateString()}`}
                </small>
              </span>
              {item.kind === "file" && (
                <button aria-label={`Download ${item.path}`}
                  className="file-row-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    void download(item);
                  }}
                >
                  <Download size={14} />
                </button>
              )}
              <button aria-label={`Manage ${item.path}`}
                className="file-row-action"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelected(item);
                  setAction("rename");
                  setActionName(item.path.split("/").at(-1) || "");
                }}
              >
                <MoreHorizontal size={14} />
              </button>
              <ChevronRight size={15} />
            </div>
          ))
        ) : (
          <div className="surface-empty">
            <File size={22} />
            <h2>{query ? "No matching files" : "This folder is empty"}</h2>
            <p>
              {query
                ? "Try a different search."
                : "Upload a file or let a bot create an artifact here."}
            </p>
          </div>
        )}
      </div>
      {selected && (
        <div className="file-preview">
          <div className="file-preview-head">
            <div>
              <strong>{selected.path}</strong>
              <small>
                {fmtSize(selected.size)} · {selected.kind}
              </small>
            </div>
            <div className="file-preview-actions">
              <button
                onClick={() => {
                  setAction("rename");
                  setActionName(selected.path.split("/").at(-1) || "");
                }}
                aria-label="Rename"
              >
                <Pencil size={15} />
              </button>
              <button onClick={() => setAction("delete")} aria-label="Delete">
                <Trash2 size={15} />
              </button>
              <button
                onClick={() => { previewController.current?.abort(); setSelected(null); setImagePreview(""); }}
                aria-label="Close preview"
              >
                <X size={17} />
              </button>
            </div>
          </div>
          {selected.kind === "directory" ? <p className="surface-empty">Folder in your shared workspace.</p> : imagePreview ? (
            <img
              className="file-image-preview"
              src={imagePreview}
              alt={selected.path}
            />
          ) : preview ? (
            <pre>{preview}</pre>
          ) : (
            <div className="surface-empty">
              <File size={22} />
              <p>Preview is available for text files.</p>
              <Button onClick={() => void download(selected)}>
                <Download size={14} /> Download
              </Button>
            </div>
          )}
        </div>
      )}
      {action && (
        <Dialog open onOpenChange={open => { if (!open && !uploading) setAction(null); }}>
          <DialogContent>
            <DialogTitle>
              {action === "mkdir"
                ? "New folder"
                : action === "rename"
                  ? "Rename item"
                  : "Delete item"}
            </DialogTitle>
            <DialogDescription>{action === "rename" ? "Enter a name or a path relative to this folder." : action === "mkdir" ? "Create a folder in the current location." : "Permanently remove this item and any files inside it."}</DialogDescription>
            {action === "delete" ? (
              <p>
                Delete <b>{selected?.path}</b>? This cannot be undone.
              </p>
            ) : (
              <input
                autoFocus
                value={actionName}
                onChange={(event) => setActionName(event.target.value)}
                placeholder="Name"
              />
            )}
            {action === "delete" && (
              <p className="file-delete-note">
                The item will be removed from the shared workspace.
              </p>
            )}
            <div>
              <Button variant="outline" onClick={() => setAction(null)}>
                Cancel
              </Button>
              <Button disabled={uploading} onClick={() => void confirmAction()}>
                {action === "delete" ? "Delete" : "Save"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}
