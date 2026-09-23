import { describe, expect, it } from "vitest";
import { mergeActivityMessages, normalizeNativeMessages, safeToolDetail } from "./transcript";

describe("transcript normalization", () => {
  it("keeps duplicate attachment ids unique without quadratic scans", () => {
    const attachments = Array.from({ length: 1200 }, (_, index) => ({
      type: "file",
      id: `att_${String(index % 600).padStart(20, "0")}`,
      name: `file-${index}`,
      mimeType: "text/plain",
      size: 1,
    }));
    const [message] = normalizeNativeMessages([{ id: "u1", type: "user", text: "files", attachments }]);
    expect(message.attachments).toHaveLength(600);
  });

  it("marks interrupted tools against the latest eligible run", () => {
    const result = mergeActivityMessages(
      [{ id: "m1", role: "assistant", content: "", createdAt: "2026-09-21T00:00:00.000Z", parts: [
        { type: "tool", id: "tool-1", name: "read", status: "running", startedAt: "2026-09-21T00:02:00.000Z" },
      ] }],
      [
        { id: "run-old", threadId: "t", status: "succeeded", startedAt: "2026-09-21T00:01:00.000Z" },
        { id: "run-new", threadId: "t", status: "cancelled", startedAt: "2026-09-21T00:03:00.000Z" },
      ],
    );
    expect(result[0].parts?.[0]).toMatchObject({ status: "interrupted" });
  });
});

it('preserves nested question options while redacting credentials', () => {
  const input={questions:[{header:'Access',question:'Choose scope',options:[{label:'Read only',description:'Read resources'}]}],token:'private'};
  expect(safeToolDetail(input)).toEqual({...input,token:'[redacted]'});
});
