import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getToken } from "../api";

export type NativeTerminalProps = {
  /** Existing session for direct runner endpoints. */
  sessionId?: string;
  /** Thread id for the control worker endpoint, which resolves the session. */
  threadId?: string;
  /** Control-worker terminal attach endpoint, normally /api/threads/:id/terminal. */
  endpoint: string;
  /** Optional token override; the app session token is used by default. */
  token?: string;
  onClose?: () => void;
};

type Attachment = {
  terminalId: string;
  sessionId: string;
  cols: number;
  rows: number;
  offset: number;
};

/** xterm frontend for the native OpenCode 2 TUI over authenticated HTTP polling. */
export function NativeTerminal({
  sessionId,
  threadId,
  endpoint,
  token,
  onClose,
}: NativeTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const attachmentRef = useRef<Attachment | undefined>(undefined);
  const offsetRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "closed" | "error"
  >("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const abort = new AbortController();
    abortRef.current = abort;
    const auth = token ?? getToken();
    const headers = () => {
      const value: Record<string, string> = { Accept: "application/json" };
      if (auth) value.Authorization = `Bearer ${auth}`;
      return value;
    };
    const post = async (url: string, body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          (await response.text()) ||
            `${response.status} ${response.statusText}`,
        );
      return response.json();
    };
    const attachUrl = new URL(endpoint, window.location.href);
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10_000,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#121110",
        foreground: "#f2eded",
        cursor: "#f2eded",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    let resizeTimer: number | undefined;
    const resize = () => {
      fit.fit();
      if (!attachmentRef.current) return;
      const cols = terminal.cols;
      const rows = terminal.rows;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void post(
          `${attachUrl.origin}${attachUrl.pathname.replace(/\/$/, "")}/${attachmentRef.current!.terminalId}/resize`,
          { cols, rows },
        ).catch(() => undefined);
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    let inputDisposable: { dispose: () => void } | undefined;
    let pollTimer: number | undefined;
    const run = async () => {
      try {
        if (!threadId && !sessionId)
          throw new Error("threadId or sessionId is required");
        const attached = (await post(
          attachUrl.toString(),
          threadId ? { threadId } : { sessionId },
        )) as Attachment;
        if (abort.signal.aborted) return;
        attachmentRef.current = attached;
        offsetRef.current = 0;
        setStatus("connected");
        fit.fit();
        await post(
          `${attachUrl.origin}${attachUrl.pathname.replace(/\/$/, "")}/${attached.terminalId}/resize`,
          { cols: terminal.cols, rows: terminal.rows },
        );
        let inputQueue = Promise.resolve();
        inputDisposable = terminal.onData((data) => {
          inputQueue = inputQueue
            .then(() =>
              post(
                `${attachUrl.origin}${attachUrl.pathname.replace(/\/$/, "")}/${attached.terminalId}/input`,
                { data },
              ),
            )
            .then(() => undefined)
            .catch((e) => {
              if (!abort.signal.aborted) {
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
              }
            });
        });
        const poll = async () => {
          if (abort.signal.aborted || !attachmentRef.current) return;
          let nextPollMs = 1000;
          try {
            const response = await fetch(
              `${attachUrl.origin}${attachUrl.pathname.replace(/\/$/, "")}/${attached.terminalId}/output?after=${offsetRef.current}`,
              { headers: headers(), signal: abort.signal },
            );
            if (!response.ok)
              throw new Error(
                (await response.text()) ||
                  `${response.status} ${response.statusText}`,
              );
            const payload = (await response.json()) as {
              data?: string;
              offset?: number;
              closed?: boolean;
            };
            if (payload.data) { terminal.write(payload.data); nextPollMs = 100; }
            if (typeof payload.offset === "number")
              offsetRef.current = payload.offset;
            if (payload.closed) {
              setStatus("closed");
              return;
            }
          } catch (e) {
            if (!abort.signal.aborted) {
              setError(e instanceof Error ? e.message : String(e));
              setStatus("error");
            }
          }
          if (!abort.signal.aborted)
            pollTimer = window.setTimeout(() => void poll(), nextPollMs);
        };
        void poll();
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    };
    void run();
    return () => {
      abort.abort();
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(pollTimer);
      inputDisposable?.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      const attached = attachmentRef.current;
      if (attached)
        void fetch(
          `${attachUrl.origin}${attachUrl.pathname.replace(/\/$/, "")}/${attached.terminalId}`,
          { method: "DELETE", headers: headers(), keepalive: true },
        ).catch(() => undefined);
      attachmentRef.current = undefined;
    };
  }, [endpoint, sessionId, threadId, token]);

  return (
    <section className="native-terminal" aria-label="OpenCode terminal">
      <div className="native-terminal-head">
        <span className={`native-terminal-status ${status}`}>{status}</span>
      </div>
      <div
        ref={hostRef}
        className="native-terminal-output"
        role="application"
        aria-label="OpenCode terminal output"
      />
      {error && <div className="native-terminal-error">{error}</div>}
    </section>
  );
}
