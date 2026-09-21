import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { request } from "../api";

type ControlAction = "acquire" | "renew" | "release" | "input";
type ControlResponse = { leaseId?: string; lease_id?: string; token?: string };
type ComputerInput = Record<string, unknown>;

// Renew well inside the server lease window so a brief network delay cannot
// make an active browser appear abandoned.
const LEASE_HEARTBEAT_MS = 15_000;
const MAX_QUEUED_INPUTS = 32;
const allowedKeys = new Set(["Backspace", "Delete", "Enter", "Escape", "Tab", "Space", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", "Control", "Alt", "Meta", "Shift"]);
const keyName = (value: string) => value === " " ? "Space" : value;

/** Translate one browser keyboard event to the intentionally small desktop
 * protocol. Printable text goes through stdin-backed text input, preserving
 * punctuation, symbols, case, and password characters without exposing them
 * as command arguments. */
export function translateComputerKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}, phase: "down" | "up"): ComputerInput[] {
  if (phase === "up") return [];
  const key = keyName(event.key);
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  if (key.length === 1 && !ctrl && !alt) return [{ type: "text", text: key }];
  if (ctrl && /^[a-zA-Z]$/.test(key)) return [{ type: "key", action: "press", key: `Control+${key.toUpperCase()}` }];
  if (alt && ["ArrowLeft", "ArrowRight"].includes(key)) return [{ type: "key", action: "press", key: `Alt+${key}` }];
  if (shift && key === "Tab") return [{ type: "key", action: "press", key: "Shift+Tab" }];
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return [];
  if (allowedKeys.has(key) || /^F(?:[1-9]|1[0-2])$/.test(key)) return [{ type: "key", action: "press", key }];
  return [];
}

export type InteractiveComputerProps = {
  frame: string;
  onClose: () => void;
  initialUrl?: string;
};

const controlRequest = (action: ControlAction, leaseId?: string, input?: ComputerInput) =>
  request<ControlResponse>("/api/computer/control", {
    method: "POST",
    body: JSON.stringify({ action, ...(leaseId ? { leaseId } : {}), ...(input ? { input } : {}) }),
  });

/** Convert a viewport pointer to coordinates in the actual image content.
 * The frame is letterboxed with object-fit: contain, so the element bounds
 * can include margins that are outside the desktop image.
 */
export function normalizeComputerPoint(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  naturalHeight: number,
) {
  const width = naturalWidth || bounds.width;
  const height = naturalHeight || bounds.height;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const contentWidth = width * scale;
  const contentHeight = height * scale;
  const offsetX = (bounds.width - contentWidth) / 2;
  const offsetY = (bounds.height - contentHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left - offsetX) / contentWidth)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top - offsetY) / contentHeight)),
  };
}

export function InteractiveComputer({ frame, onClose, initialUrl }: InteractiveComputerProps) {
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const leaseRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<"idle" | "acquiring" | "controlling" | "error">("idle");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const queue = useRef<Array<{ input: ComputerInput; pointerMove: boolean; lease: string }>>([]);
  const draining = useRef(false);

  const setLease = useCallback((value: string | null) => {
    leaseRef.current = value;
    if (mounted.current) setLeaseId(value);
  }, []);

  const release = useCallback(async (keepError = false) => {
    const current = leaseRef.current;
    if (!current) return;
    leaseRef.current = null;
    queue.current = [];
    if (mounted.current) {
      setLeaseId(null);
      setStatus(keepError ? "error" : "idle");
    }
    try {
      await controlRequest("release", current);
    } catch {
      // The lease is cleared locally even when the connection has gone away.
    }
  }, []);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queue.current.length && leaseRef.current) {
        const next = queue.current.shift()!;
        if (next.lease !== leaseRef.current) continue;
        await controlRequest("input", next.lease, next.input);
      }
    } catch (e) {
      queue.current = [];
      if (mounted.current) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Computer input failed.");
      }
      await release(true);
    } finally {
      draining.current = false;
    }
  }, [release]);

  const enqueue = useCallback((input: ComputerInput, pointerMove = false) => {
    if (!leaseRef.current) return;
    if (pointerMove) {
      const index = queue.current.findIndex((item) => item.pointerMove);
      if (index >= 0) {
        queue.current[index] = { input, pointerMove: true, lease: leaseRef.current };
        void drain();
        return;
      }
    }
    if (queue.current.length >= MAX_QUEUED_INPUTS) {
      const index = queue.current.findIndex((item) => item.pointerMove);
      if (index >= 0) queue.current.splice(index, 1);
      else if (pointerMove) return;
      else {
        queue.current = [];
        setStatus("error");
        setError("Computer input queue is full; control was released safely.");
        void release(true);
        return;
      }
    }
    queue.current.push({ input, pointerMove, lease: leaseRef.current });
    void drain();
  }, [drain, release]);

  const acquire = async () => {
    if (leaseRef.current || status === "acquiring") return;
    setStatus("acquiring");
    setError("");
    try {
      const result = await controlRequest("acquire");
      const acquired = result.leaseId ?? result.lease_id ?? result.token;
      if (!acquired) throw new Error("The computer did not grant a control lease.");
      if (!mounted.current) {
        await controlRequest("release", acquired).catch(() => undefined);
        return;
      }
      setLease(acquired);
      setStatus("controlling");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Could not take control of the computer.");
    }
  };

  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) void release();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", hide);
      void release();
    };
  }, [release]);

  useEffect(() => {
    if (!leaseId) return;
    const timer = window.setInterval(async () => {
      const current = leaseRef.current;
      if (!current) return;
      try {
        await controlRequest("renew", current);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Computer control lease expired.");
        await release(true);
      }
    }, LEASE_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [leaseId, release]);

  const point = (event: { clientX: number; clientY: number; currentTarget: HTMLImageElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return normalizeComputerPoint(event, bounds, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
  };
  const pointer = (event: PointerEvent<HTMLImageElement>, type: string) => {
    if (!leaseRef.current) return;
    event.preventDefault();
    const buttons = ["left", "middle", "right"] as const;
    enqueue({ type, ...point(event), button: buttons[event.button] ?? "left" }, type === "move");
  };
  const key = (event: KeyboardEvent<HTMLDivElement>, phase: "down" | "up") => {
    if (!leaseRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    for (const input of translateComputerKey(event, phase)) enqueue(input);
  };
  const scroll = (event: WheelEvent<HTMLImageElement>) => {
    if (!leaseRef.current) return;
    event.preventDefault();
    enqueue({ type: "scroll", ...point(event as unknown as PointerEvent<HTMLImageElement>), deltaX: event.deltaX, deltaY: event.deltaY });
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const value = event.clipboardData.getData("text");
    if (value) enqueue({ type: "text", text: value });
  };
  const sendText = () => {
    if (!text || !leaseRef.current) return;
    enqueue({ type: "text", text });
    setText("");
  };
  const openLogin = () => {
    if (!leaseRef.current || !initialUrl) return;
    enqueue({ type: "key", action: "press", key: "Control+L" });
    enqueue({ type: "text", text: initialUrl });
    enqueue({ type: "key", action: "press", key: "Enter" });
  };

  return (
    <section aria-label="Interactive computer" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, height: "100%" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <strong>Live computer</strong>
          <span style={{ marginLeft: 10, color: "var(--muted)", fontSize: 11 }}>
            {status === "controlling" ? "You have control" : status === "acquiring" ? "Taking control…" : status === "error" ? "Control unavailable" : "Bot control"}
          </span>
        </div>
        <button className="icon-btn" type="button" onClick={() => { void release().finally(onClose); }} aria-label="Close live computer">×</button>
      </header>
      <div
        tabIndex={0}
        onPointerDown={(event) => event.currentTarget.focus()}
        onKeyDown={(event) => key(event, "down")}
        onKeyUp={(event) => key(event, "up")}
        style={{ flex: 1, minHeight: 0, outline: "none" }}
      >
        <img
          src={frame}
          alt="Live view of the shared computer"
          draggable={false}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer(event, "down"); }}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerUp={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={(event) => { pointer(event, "up"); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onWheel={scroll}
          onContextMenu={(event) => event.preventDefault()}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", background: "#070605", cursor: leaseId ? "crosshair" : "default", touchAction: "none" }}
        />
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {!leaseId ? <button className="primary-btn" type="button" onClick={() => void acquire()} disabled={status === "acquiring"}>{status === "acquiring" ? "Taking control…" : "Take control"}</button> : <button className="soft-btn" type="button" onClick={() => void release()}>Return to bot</button>}
        {leaseId && initialUrl ? <button className="primary-btn" type="button" onClick={openLogin}>Open login in Computer</button> : null}
        <input className="text-input" aria-label="Text to send to computer" value={text} maxLength={16_000} onChange={(event) => setText(event.target.value)} onPaste={paste} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); sendText(); } }} placeholder="Type text to send…" disabled={!leaseId} />
        <button className="soft-btn" type="button" onClick={sendText} disabled={!leaseId || !text}>Send text</button>
        <button className="soft-btn" type="button" onClick={() => { void release().finally(onClose); }}>Close</button>
      </div>
    </section>
  );
}
