import { FileText, LoaderCircle, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { Attachment } from "../api";
import { api } from "../api";

export const MAX_ATTACHMENTS = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export async function uploadFiles(files: File[], existing: Attachment[], onChange: (update: Attachment[] | ((current: Attachment[]) => Attachment[])) => void, onError: (message: string) => void) {
  const available = Math.max(0, MAX_ATTACHMENTS - existing.length);
  let totalBytes = existing.reduce((sum, item) => sum + item.size, 0);
  for (const file of files.slice(0, available)) {
    if (file.size > MAX_BYTES) { onError(`${file.name} is larger than 10 MiB.`); continue; }
    if (totalBytes + file.size > MAX_TOTAL_BYTES) { onError("Attachments must total 20 MiB or less."); continue; }
    try {
      const attachment = await api.upload(file);
      onChange((current) => [...current, attachment]);
      totalBytes += file.size;
    } catch (error) {
      onError(error instanceof Error ? error.message : `Could not upload ${file.name}`);
    }
  }
  if (files.length > available) onError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
}

export function ChatAttachments({ attachments, onChange, onFiles, uploading }: {
  attachments: Attachment[];
  onChange: (update: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
  onFiles: (files: File[]) => void;
  uploading: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const add = (files: File[]) => { if (files.length && !uploading) onFiles(files); };
  return (
    <div className="chat-attachments" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void add([...event.dataTransfer.files]); }}>
      <input ref={input} type="file" multiple hidden onChange={(event) => { void add([...event.target.files ?? []]); event.currentTarget.value = ""; }} />
      {attachments.map((attachment) => (
        <span className="attachment-chip" key={attachment.id} title={attachment.name}>
          <FileText size={13} /> <span>{attachment.name}</span>
          <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}><X size={12} /></button>
        </span>
      ))}
      <button type="button" className="attach-button" onClick={() => input.current?.click()} disabled={uploading || attachments.length >= MAX_ATTACHMENTS} aria-label="Attach files" title="Attach files">
        {uploading ? <LoaderCircle size={16} className="spin" /> : <Paperclip size={16} />}
      </button>
    </div>
  );
}

export function AttachmentCards({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null;
  return <div className="transcript-attachments">{attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} />)}</div>;
}

function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const image = /^(image\/(png|jpe?g|gif|webp))$/i.test(attachment.mimeType);
  const canonical = /^att_[0-9a-f-]{20,80}$/i.test(attachment.id);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const open = async () => {
    if (!canonical) { setError("Attachment is no longer available."); return; }
    try {
      const blob = await api.download(attachment.id);
      if (!image) {
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href; anchor.download = attachment.name; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(href), 0);
        return;
      }
      const next = URL.createObjectURL(blob);
      setUrl((current) => { if (current) URL.revokeObjectURL(current); return next; });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load attachment"); }
  };
  const download = async (event: MouseEvent) => {
    event.stopPropagation();
    if (!canonical) { setError("Attachment is no longer available."); return; }
    try {
      const blob = await api.download(attachment.id);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href; anchor.download = attachment.name; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not download attachment"); }
  };
  return <div className="transcript-attachment" role="button" tabIndex={0} onClick={() => void open()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void open(); }} title={image ? "Preview attachment" : "Download attachment"}>
    {image && url ? <img src={url} alt={attachment.name} /> : <FileText size={18} />}
    <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)} · {attachment.mimeType}</small>{error && <small className="attachment-error">{error}</small>}<a href="#download" onClick={(event) => { event.preventDefault(); void download(event); }}>Download</a></span>
  </div>;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
