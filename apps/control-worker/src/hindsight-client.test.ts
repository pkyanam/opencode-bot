import { describe, expect, it, vi } from "vitest";
import { HindsightClient, HindsightError } from "./hindsight-client";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("HindsightClient", () => {
  it("keeps every request bank scoped and sends async idempotent retain", async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) =>
      reply({ path, method: init?.method, body: init?.body }),
    );
    const client = new HindsightClient(fetcher);
    await client.createBank("bot/a", "Bot");
    await client.retain(
      "bot/a",
      [{ content: "hello", document_id: "session-1", tags: ["acl:bot/a"] }],
      "00000000-0000-0000-0000-000000000001",
    );
    await client.reflect("bot/a", "what happened?");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/v1/default/banks/bot%2Fa",
      "/v1/default/banks/bot%2Fa/memories",
      "/v1/default/banks/bot%2Fa/reflect",
    ]);
    expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toMatchObject({
      async: true,
      operation_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(
      JSON.parse(fetcher.mock.calls[2][1]?.body as string).include,
    ).toEqual({ facts: {} });
  });

  it("rejects unreadable successful responses instead of reporting empty recall", async () => {
    const client = new HindsightClient(async () => new Response("not-json", {status:200}));
    await expect(client.recall("bank", "preferences")).rejects.toMatchObject({status:502});
    const deletion = new HindsightClient(async () => new Response(null, {status:204}));
    await expect(deletion.deleteBank("bank")).resolves.toBeUndefined();
  });

  it("exposes status and redacted structured errors", async () => {
    const client = new HindsightClient(
      vi.fn(async () => reply({ detail: "denied" }, 403)),
    );
    await expect(client.deleteBank("x")).rejects.toMatchObject({
      name: "HindsightError",
      status: 403,
      body: { detail: "denied" },
    });
    await expect(client.deleteBank("x")).rejects.toBeInstanceOf(HindsightError);
  });

  it("uses the supervisor error string for friendly bounded failures", async () => {
    const detail = "upstream request timed out";
    const client = new HindsightClient(
      vi.fn(async () => reply({ error: detail }, 502)),
    );
    await expect(client.recall("x", "query")).rejects.toMatchObject({
      message: `Hindsight request failed: ${detail}`,
      status: 502,
    });

    const long = "x".repeat(2_000);
    const bounded = new HindsightClient(
      vi.fn(async () => reply({ error: long }, 502)),
    );
    await expect(bounded.recall("x", "query")).rejects.toSatisfy((error: unknown) =>
      error instanceof HindsightError && error.message.length <= 530,
    );
  });
});

it("preserves startup status so background questions can wait for the service", async () => {
  const startup = Object.assign(new Error("Hindsight is starting its database and models."), {status:503});
  const client = new HindsightClient(async () => { throw startup; });
  await expect(client.reflect("bank", "question", "low")).rejects.toMatchObject({status:503,message:startup.message});
});
