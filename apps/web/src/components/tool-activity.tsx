import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  LoaderCircle,
  TerminalSquare,
  Users,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ToolPart } from "../api";

const MAX_OUTPUT = 16_000;

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function targetFor(part: ToolPart): string {
  const input = part.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return "";
  const keys = ["url", "href", "path", "filePath", "file", "filename", "command", "cmd", "recipient", "bot", "botName", "threadId"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function toolActionLabel(name: string): string {
  const key = name.toLowerCase().replace(/[.\s-]+/g, "_");
  const known: Record<string, string> = {
    browser_navigate: "Open page",
    browser_snapshot: "Inspect page",
    browser_click: "Click page element",
    browser_type: "Type into page",
    browser_console_messages: "Check browser console",
    browser_evaluate: "Inspect page state",
    browser_wait_for: "Wait for page",
    browser_take_screenshot: "Capture screenshot",
    browser_tabs: "Manage browser tabs",
    browser_resize: "Resize browser",
    browser_network_requests: "Check network requests",
    browser_run_code: "Run browser action",
    webfetch: "Fetch page",
    websearch: "Search the web",
    bots_list_bots: "Find bots",
    bots_get_replies: "Read bot replies",
    shell: "Run command",
    exec: "Run command",
    execute: "Run code",
    read: "Read file",
    write: "Write file",
    edit: "Edit file",
    glob: "Find files",
    grep: "Search files",
    bots_send_message: "Message another bot",
    delegate: "Delegate task",
  };
  if (known[key]) return known[key];
  const suffix = Object.keys(known).sort((a,b)=>b.length-a.length).find(name=>key.endsWith(`_${name}`));
  if (suffix) return known[suffix];
  const normalized = name.replace(/[._-]+/g, " ").trim();
  return normalized ? normalized.replace(/\b\w/g, (c) => c.toUpperCase()) : "Tool action";
}

function Icon({ part }: { part: ToolPart }) {
  const name = part.name.toLowerCase();
  if (name.includes("browser") || name.includes("web") || name.includes("url")) return <ExternalLink size={14} />;
  if (name.includes("file") || name.includes("read") || name.includes("write")) return <FileText size={14} />;
  if (name.includes("shell") || name.includes("command") || name.includes("terminal") || name.includes("exec")) return <TerminalSquare size={14} />;
  if (name.includes("message") || name.includes("delegate") || name.includes("bot")) return <Users size={14} />;
  return <Wrench size={14} />;
}

export function ToolActivity({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running" || part.status === "queued";
  const failed = part.status === "failed" || part.status === "interrupted";
  const output = part.output || part.error || "";
  const bounded = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n… output truncated` : output;
  const preview = output.split("\n").map((line) => line.trim()).find(line => line && !/^#{1,6}\s|^```|^await page\./.test(line))?.slice(0, 200) ?? "";
  const inputText = part.input == null ? "" : text(part.input);
  const details = output || inputText;
  const target = useMemo(() => targetFor(part), [part]);
  const label = toolActionLabel(part.name);
  return (
    <div className={`tool-activity ${running ? "tool-running" : ""} ${failed ? "tool-failed" : ""}`}>
      <button className="tool-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon"><Icon part={part} /></span>
        <span className="tool-copy">
          <strong>{label}</strong>
          {target && <span className="tool-target" title={target}>{target}</span>}
        </span>
        <span className="tool-state" aria-label={running ? "Running" : part.status === "interrupted" ? "Interrupted" : failed ? "Failed" : "Completed"}>
          {running ? <LoaderCircle size={14} className="spin" /> : failed ? <AlertCircle size={14} /> : <Check size={14} />}
        </span>
        {details && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {!running && (part.error || preview) && <div className="tool-preview">{part.error || preview}</div>}
      {open && details && <pre className="tool-output">{[inputText ? `Input\n${inputText.slice(0, 6000)}` : "", output ? `Result\n${bounded}` : ""].filter(Boolean).join("\n\n")}</pre>}
    </div>
  );
}
