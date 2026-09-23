import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TITLE_MODEL,
  generateConversationTitle,
  normalizeConversationTitle,
  scheduleConversationTitle,
} from "./conversation-title";

function store(title = "New conversation") {
  return {
    getTitle: vi.fn(() => title),
    updateTitleIfUnchanged: vi.fn((_: string, expected: string) => expected === title),
  };
}

describe("conversation title generation", () => {
  it("normalizes model output and bounds it for the conversation list", () => {
    expect(normalizeConversationTitle(' Title:  "Plan the launch!" ')).toBe("Plan the launch");
    expect(normalizeConversationTitle("```\nignored\n```\n" )).toBeUndefined();
    expect(normalizeConversationTitle(" ")).toBeUndefined();
    expect(normalizeConversationTitle("x".repeat(100))).toHaveLength(80);
  });

  it("uses the configured model and updates through the title CAS", async () => {
    const target = store();
    const generate = vi.fn(async ({ model, prompt }: { model: string; prompt: string }) => {
      expect(model).toBe("local/title-model");
      expect(prompt).toContain("first message");
      return "Launch planning";
    });
    await generateConversationTitle({
      threadId: "thr_1",
      prompt: "first message: plan the launch",
      currentTitle: "New conversation",
      model: "local/title-model",
      store: target,
      generate,
    });
    expect(target.updateTitleIfUnchanged).toHaveBeenCalledWith("thr_1", "New conversation", "Launch planning");
  });

  it("does not overwrite a manual rename that wins while generation is running", async () => {
    const target = store("A manual title");
    const generate = vi.fn(async () => "Generated title");
    await generateConversationTitle({
      threadId: "thr_1",
      prompt: "first message",
      currentTitle: "New conversation",
      store: target,
      generate,
    });
    expect(target.updateTitleIfUnchanged).toHaveBeenCalledWith("thr_1", "New conversation", "Generated title");
    expect(target.updateTitleIfUnchanged).toHaveReturnedWith(false);
  });

  it("is nonblocking for callers and defaults the model", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const target = store();
    const generate = vi.fn(() => pending);
    const scheduled: Promise<void>[] = [];
    scheduleConversationTitle({ threadId: "thr_1", prompt: "first message", currentTitle: "New conversation", store: target, generate, schedule: (work) => scheduled.push(work) });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_TITLE_MODEL }));
    expect(target.updateTitleIfUnchanged).not.toHaveBeenCalled();
    resolve("A title");
    await scheduled[0];
    expect(target.updateTitleIfUnchanged).toHaveBeenCalled();
  });
});
