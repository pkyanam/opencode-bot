import type { Message } from "../api";

/** OpenCode lists newest first; a conversation is always displayed oldest first. */
export function normalizeNativeMessages(input: any[]): Message[] {
  return input
    .filter((m) => m.type === "user" || m.type === "assistant")
    .slice()
    .sort(
      (a, b) =>
        (a.time?.created ?? 0) - (b.time?.created ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((m) => ({
      id: m.id,
      role: m.type,
      content:
        m.type === "user"
          ? String(m.text ?? "")
          : (m.content ?? [])
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n"),
      createdAt: m.time?.created
        ? new Date(m.time.created).toISOString()
        : undefined,
      ...(m.error
        ? {
            error:
              typeof m.error === "string"
                ? m.error
                : String(
                    m.error.message ??
                      m.error.type ??
                      "OpenCode could not complete this request.",
                  ),
          }
        : {}),
    }))
    .filter((m) => m.content.trim() || m.error);
}
