import { expect, it } from "vitest";
import { mergeDelegationTimeline } from "./delegation-timeline";

const message = (id: string, createdAt: string) => ({
  id,
  role: "assistant" as const,
  content: id,
  createdAt,
});

const delegation = (id: string, createdAt: string, status = "running") => ({
  id,
  targetBotId: `bot-${id}`,
  targetBotName: id,
  targetThreadId: `thread-${id}`,
  prompt: `Prompt ${id}`,
  status,
  createdAt,
  updatedAt: createdAt,
});

it("anchors handoffs by creation time instead of appending them", () => {
  const timeline = mergeDelegationTimeline(
    [message("before", "2026-09-21T00:00:00Z"), message("after", "2026-09-21T00:02:00Z")],
    [delegation("peer", "2026-09-21T00:01:00Z")],
  );
  expect(timeline.map((item) => item.kind === "message" ? item.message.id : item.delegation.id)).toEqual([
    "before",
    "peer",
    "after",
  ]);
});

it("keeps same-card status updates attached to the delegation id", () => {
  const timeline = mergeDelegationTimeline(
    [message("user", "2026-09-21T00:00:00Z")],
    [delegation("peer", "2026-09-21T00:01:00Z", "succeeded")],
  );
  expect(timeline[1]).toMatchObject({
    kind: "delegation",
    delegation: { id: "peer", status: "succeeded" },
  });
});

it("preserves native message order when timestamps tie", () => {
  const timeline = mergeDelegationTimeline(
    [message("native", "2026-09-21T00:01:00Z")],
    [delegation("peer", "2026-09-21T00:01:00Z")],
  );
  expect(timeline.map((item) => item.kind === "message" ? item.message.id : item.delegation.id)).toEqual([
    "native",
    "peer",
  ]);
});

it("never reorders native messages with missing or skewed clocks", () => {
  const native = [{ id: "user", role: "user", content: "Start" }, message("late", "2026-09-21T00:03:00Z"), message("early", "2026-09-21T00:02:00Z")];
  const result = mergeDelegationTimeline(native, [delegation("peer", "2026-09-21T00:01:00Z")]);
  expect(result.filter(item => item.kind === "message").map(item => item.message.id)).toEqual(["user", "late", "early"]);
  expect(result[1].kind).toBe("delegation");
});
