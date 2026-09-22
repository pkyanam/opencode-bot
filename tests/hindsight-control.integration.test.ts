import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/computer-cloudflare/src/index", () => ({
  CloudflareComputerProvider: class {
    async isRunning() {
      return false;
    }
    async ensure() {
      throw new Error("sandbox must not be started by Hindsight tests");
    }
  },
}));
vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {} }));
import worker, { Workspace } from "../apps/control-worker/src/index";

const databases: DatabaseSync[] = [];
const upstream = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: RequestInit }>,
  status: 200,
  body: { results: [] as unknown[] },
}));

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const kv = new Map<string, unknown>();
  const storage = {
    sql: {
      exec(query: string, ...args: any[]) {
        const statement = db.prepare(query);
        const read = statement.columns().length > 0;
        const rows = read ? statement.all(...args) : [];
        return {
          toArray: () => rows,
          rowsWritten: read ? 0 : Number(statement.run(...args).changes),
        };
      },
    },
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: async () => {},
    transactionSync: <T>(fn: () => T) => fn(),
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    delete: async (key: string) => kv.delete(key),
  };
  const env: any = { APP_TOKEN: "owner-secret", RUNNER_TOKEN: "runner-secret" };
  let workspace = new Workspace(
    {
      storage,
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
      waitUntil: () => {},
    } as any,
    env,
  );
  env.WORKSPACE = {
    idFromName: () => "owner",
    get: () => ({ fetch: (request: Request) => workspace.fetch(request) }),
  };
  const request = async (
    path: string,
    method = "GET",
    input?: unknown,
    token: string | null = env.APP_TOKEN,
  ) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    const result = await worker.fetch(
      new Request(`https://bot.test${path}`, {
        method,
        headers,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
      env,
    );
    const text = await result.text();
    let body: any = undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: result.status, body };
  };
  return {
    request,
    schedule: storage.setAlarm,
    env,
    kv,
    sync: () => (workspace as any).hindsight().tick(),
    restart: () => {
      workspace = new Workspace(
        {
          storage,
          blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
          waitUntil: () => {},
        } as any,
        env,
      );
    },
  };
}

async function pair(f: ReturnType<typeof fixture>) {
  const invite = await f.request("/api/pairing/invites", "POST", {
    label: "Hindsight test",
  });
  const redeemed = await f.request(
    "/api/pairing/redeem",
    "POST",
    {
      secret: invite.body.qrSecret,
      deviceName: "Test client",
      clientType: "web",
    },
    null,
  );
  return redeemed.body.deviceToken as string;
}

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  upstream.calls.length = 0;
  upstream.status = 200;
  upstream.body = { results: [] };
  vi.unstubAllGlobals();
});

describe("Hindsight control-plane integration", () => {
  it("schedules projection cleanup for legacy memory mutations and bot deletion", async () => {
    const f = fixture();
    const bot = await f.request("/api/bots", "POST", {name:"Legacy",model:"test/model",instructions:""});
    await f.request("/api/memory/engine", "PATCH", {url:"https://hindsight.example",enabled:true});
    f.schedule.mockClear();
    const memory = await f.request(`/api/bots/${bot.body.id}/memory`, "POST", {content:"Preference for concise answers"});
    expect(memory.status).toBe(201);
    expect(f.schedule).toHaveBeenCalled();
    f.schedule.mockClear();
    expect((await f.request(`/api/bots/${bot.body.id}/memory/${memory.body.id}`, "DELETE")).status).toBe(200);
    expect(f.schedule).toHaveBeenCalled();
    f.schedule.mockClear();
    expect((await f.request(`/api/bots/${bot.body.id}`, "DELETE")).status).toBe(200);
    expect(f.schedule).toHaveBeenCalled();
  });

  it("requires owner or paired authorization and never exposes the engine key", async () => {
    const f = fixture();
    expect(
      (await f.request("/api/memory/engine", "GET", undefined, null)).status,
    ).toBe(401);
    const clientToken = await pair(f);
    expect(
      (await f.request("/api/memory/engine", "GET", undefined, clientToken))
        .status,
    ).toBe(200);
    const configured = await f.request("/api/memory/engine", "PATCH", {
      url: "https://hindsight.example",
      apiKey: "super-secret",
      enabled: true,
      autoCapture: true,
    });
    expect(configured.status).toBe(200);
    expect(JSON.stringify(configured.body)).not.toContain("super-secret");
    const status = await f.request("/api/memory/engine");
    expect(JSON.stringify(status.body)).not.toContain("super-secret");
    expect(JSON.stringify((await f.request("/api/state")).body)).not.toContain(
      "super-secret",
    );
  });

  it("scopes external recall and reflect to the requested bot and rejects unbounded budgets", async () => {
    const f = fixture();
    const bot = await f.request("/api/bots", "POST", {
      name: "Builder",
      instructions: "",
      model: "test/model",
    });
    expect(bot.status).toBe(201);
    await f.request("/api/memory/engine", "PATCH", {
      url: "https://hindsight.example",
      apiKey: "provider-key",
      enabled: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        upstream.calls.push({ url: String(input), init });
        return Response.json(upstream.body, { status: upstream.status });
      }),
    );
    await f.sync();
    const recalled = await f.request("/api/memory/recall", "POST", {
      botId: bot.body.id,
      query: "deploy",
      budget: "mid",
    });
    expect(recalled.status).toBe(200);
    expect(upstream.calls.at(-1)?.url).toContain(
      bot.body.id.replaceAll("-", "_"),
    );
    const rejected = await f.request("/api/memory/recall", "POST", {
      botId: bot.body.id,
      query: "deploy",
      budget: "unbounded",
    });
    expect(rejected.status).toBe(400);
    const reflected = await f.request("/api/memory/reflect", "POST", {
      botId: bot.body.id,
      query: "what changed",
      budget: "low",
    });
    expect(reflected.status).toBe(200);
    expect(upstream.calls.at(-1)?.url).toContain(
      bot.body.id.replaceAll("-", "_"),
    );
  });

  it("fails provider relays safely and never accepts an arbitrary external model URL", async () => {
    const f = fixture();
    const bot = await f.request("/api/bots", "POST", {
      name: "Builder",
      instructions: "",
      model: "test/model",
    });
    await f.request("/api/memory/engine", "PATCH", {
      url: "https://hindsight.example",
      apiKey: "provider-key",
      enabled: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        upstream.calls.push({ url: String(input), init });
        return Response.json({ error: "invalid token" }, { status: 401 });
      }),
    );
    const failed = await f.request("/api/memory/recall", "POST", {
      botId: bot.body.id,
      query: "deploy",
      budget: "high",
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(failed.body)).not.toContain("provider-key");
    const arbitrary = await f.request("/api/memory/recall", "POST", {
      botId: bot.body.id,
      query: "deploy",
      budget: "high",
      url: "https://evil.example/model",
      model: "unbounded",
    });
    expect(arbitrary.status).toBe(400);
    expect(
      upstream.calls.every((call) => !call.url.includes("evil.example")),
    ).toBe(true);
  });

  it("restricts native memory inference to its dedicated capability and fixed model", async () => {
    const f = fixture();
    f.env.AI = { run: vi.fn(async () => ({ response: "memory answer" })) };
    const input = {
      messages: [{ role: "user", content: "Recall preferences" }],
      model: "untrusted/model",
      max_tokens: 999999,
    };
    const path = "/internal/hindsight/ai/v1/chat/completions";
    expect((await f.request(path, "POST", input)).status).toBe(401);
    expect((await f.request(path, "POST", input, "runner-secret")).status).toBe(
      401,
    );
    expect(f.env.AI.run).not.toHaveBeenCalled();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("owner-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode("memory-v1:hindsight-ai-v1"),
    );
    const token = `hindsight-ai-v1.${Buffer.from(signature).toString("base64url")}`;
    const result = await f.request(path, "POST", input, token);
    expect(result.status).toBe(200);
    expect(result.body.choices[0].message.content).toBe("memory answer");
    expect(f.env.AI.run).toHaveBeenCalledWith(
      "@cf/zai-org/glm-5.3-flash",
      expect.objectContaining({ max_tokens: 12000, stream: false }),
    );
  });

  it("keeps the run-scoped tools namespace behind its capability token", async () => {
    const f = fixture();
    expect(
      (
        await f.request(
          "/api/memory/tools",
          "POST",
          { name: "memory_recall", arguments: { query: "deploy" } },
          null,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          "/api/memory/tools",
          "POST",
          { name: "memory_recall", arguments: { query: "deploy" } },
          "wrong-token",
        )
      ).status,
    ).toBe(401);
    expect(
      (await f.request("/api/memory/tools", "GET", undefined, null)).status,
    ).toBe(405);
  });
});
