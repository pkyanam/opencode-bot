import { useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { request, type Bot } from "../api";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

type Delegation = {
  id: string;
  targetBotId: string;
  targetBotName: string;
  targetThreadId: string;
  prompt: string;
  status: string;
  result?: string;
  error?: string;
};
export function Delegations({
  threadId,
  botId,
  bots,
  open,
  onClose,
  onNavigate,
}: {
  threadId: string;
  botId: string;
  bots: Bot[];
  open: boolean;
  onClose: () => void;
  onNavigate: (botId: string, threadId: string) => void;
}) {
  const [items, setItems] = useState<Delegation[]>([]);
  const [target, setTarget] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targets = bots.filter((b) => b.id !== botId);
  useEffect(() => {
    setTarget(targets[0]?.id ?? "");
    setPrompt("");
    setItems([]);
    setError("");
  }, [threadId, botId]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await request<Delegation[]>(
          `/api/threads/${threadId}/delegations`,
        );
        if (!cancelled) setItems(next);
      } catch {
        /* Keep previous receipts while reconnecting. */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !target || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<Delegation>(
        `/api/threads/${threadId}/delegations`,
        {
          method: "POST",
          body: JSON.stringify({
            targetBotId: target,
            prompt: prompt.trim(),
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      setItems((current) => [result, ...current]);
      setPrompt("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delegate this task");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {items.length > 0 && (
        <section className="delegation-list" aria-label="Delegated tasks">
          {items.map((item) => (
            <details className="delegation-card" key={item.id}>
              <summary>
                <span>
                  <ArrowUpRight size={15} /> {item.targetBotName}
                </span>
                <span>{item.status.replaceAll("_", " ")}</span>
              </summary>
              <p>{item.prompt}</p>
              {item.result && (
                <div className="delegation-result">{item.result}</div>
              )}
              {item.error && <p role="alert">{item.error}</p>}
              <button
                className="soft-btn"
                onClick={() =>
                  onNavigate(item.targetBotId, item.targetThreadId)
                }
              >
                Open {item.targetBotName}’s conversation{" "}
                <ArrowUpRight size={14} />
              </button>
            </details>
          ))}
        </section>
      )}
      {open && (
        <Dialog open onOpenChange={(value) => !value && onClose()}>
          <DialogContent className="delegate-dialog">
            <DialogTitle>Delegate to another bot</DialogTitle>
            <p>
              The recipient uses its own settings and a separate conversation.
              Its result returns here and becomes context for your next message.
            </p>
            <form onSubmit={submit}>
              <label className="field-label" htmlFor="delegate-target">
                Recipient
              </label>
              <select
                id="delegate-target"
                className="settings-input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {targets.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor="delegate-prompt">
                Task or message
              </label>
              <textarea
                id="delegate-prompt"
                className="text-area"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                maxLength={20000}
                placeholder="Give this bot a clear task and the context it needs."
              />
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
              <div className="settings-actions">
                <button
                  className="primary-btn"
                  type="submit"
                  disabled={busy || !target || !prompt.trim()}
                >
                  {busy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <ArrowUpRight size={14} />
                  )}{" "}
                  Delegate
                </button>
                <button className="soft-btn" type="button" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
