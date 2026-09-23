/**
 * Conversation title generation.
 *
 * This module deliberately knows nothing about a particular OpenCode host.
 * Cloudflare, Boat, and owned-node callers provide the same small text
 * generation function, while the durable store supplies a compare-and-set
 * title update. This keeps generation out of the request's critical path and
 * makes late completions safe after a user rename.
 */

/** Empty means use the conversation bot's configured model. */
export const DEFAULT_TITLE_MODEL = "";
export const DEFAULT_TITLE = "New conversation";
export const MAX_TITLE_LENGTH = 80;

export type TitleTextGenerator = (input: {
  model: string;
  prompt: string;
}) => Promise<string>;

export type ConversationTitleStore = {
  /** Return the current title, or undefined when the conversation vanished. */
  getTitle: (threadId: string) => string | undefined | Promise<string | undefined>;
  /** Update only when the title is still expectedTitle. */
  updateTitleIfUnchanged: (
    threadId: string,
    expectedTitle: string,
    nextTitle: string,
  ) => boolean | Promise<boolean>;
};

export type TitleGenerationOptions = {
  threadId: string;
  prompt: string;
  currentTitle: string;
  model?: string;
  store: ConversationTitleStore;
  generate: TitleTextGenerator;
  /** Used by callers that need to attach work to a request/DO lifecycle. */
  schedule?: (work: Promise<void>) => void;
};

/**
 * Make model output suitable for a compact conversation list. Model output is
 * treated as untrusted text: remove markup/control characters, collapse
 * whitespace, and reject empty or generic answers.
 */
export function normalizeConversationTitle(value: string): string | undefined {
  const title = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:title\s*:\s*)?/i, "")
    .replace(/["'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;,:]+$/, "")
    .trim();
  if (!title || /^new conversation$/i.test(title) || /^untitled$/i.test(title)) return undefined;
  return title.slice(0, MAX_TITLE_LENGTH).trim() || undefined;
}

export function titlePrompt(userPrompt: string): string {
  return [
    "Create a short conversation title for the user's first message.",
    "Return only the title, with no quotes, punctuation, markdown, or explanation.",
    "Use at most 6 words and keep the wording specific.",
    `User message:\n${userPrompt.slice(0, 4000)}`,
  ].join("\n\n");
}

/** Start generation without making the caller await it. */
export function scheduleConversationTitle(options: TitleGenerationOptions): void {
  const work = generateConversationTitle(options);
  if (options.schedule) options.schedule(work);
  else void work;
}

/** Awaitable form, useful for deterministic tests and lifecycle adapters. */
export async function generateConversationTitle(options: TitleGenerationOptions): Promise<void> {
  const prompt = options.prompt.trim();
  if (!prompt || !options.threadId || !options.currentTitle.trim()) return;
  const generated = await options.generate({
    model: options.model?.trim() || DEFAULT_TITLE_MODEL,
    prompt: titlePrompt(prompt),
  });
  const title = normalizeConversationTitle(generated);
  if (!title) return;
  // CAS is the race guard: a manual rename, or another title worker that won
  // first, makes this update a no-op.
  await options.store.updateTitleIfUnchanged(options.threadId, options.currentTitle, title);
}
