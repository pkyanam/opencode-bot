import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { request, type Bot } from "../api";
import { MarkdownContent } from "./markdown-content";

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
  onNavigate,
}: {
  threadId: string;
  botId: string;
  bots: Bot[];
  onNavigate: (botId: string, threadId: string) => void;
}) {
  const [items, setItems] = useState<Delegation[]>([]);
  useEffect(() => {
    setItems([]);
  }, [threadId]);
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
  return (
    <>
      {items.length > 0 && (
        <section className="delegation-list" aria-label="Bot replies">
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
                <MarkdownContent className="delegation-result">
                  {item.result}
                </MarkdownContent>
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
    </>
  );
}
