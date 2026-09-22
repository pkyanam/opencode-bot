import { getSandbox } from "@cloudflare/sandbox";
import { MemoryError } from "./memory-registry";

/** Dedicated memory compute, never the bot's Computer. Its PG database is a
 * rebuildable projection of committed registry records, not the durable source. */
export class CloudflareHindsight {
  private starting?: Promise<void>;
  private sandbox: any;
  private checkedAt = 0;
  constructor(
    private options: {
      namespace: any;
      token: string;
      origin: () => Promise<string>;
      modelToken: () => Promise<string>;
      instance: (id: string) => void;
    },
  ) {}
  private async prepare() {
    if (this.starting) return this.starting;
    if (this.sandbox && Date.now() - this.checkedAt < 10000) return;
    this.starting = (async () => {
      this.sandbox ??= getSandbox(this.options.namespace, "hindsight-memory", {
        keepAlive: false,
        sleepAfter: "10m",
      });
      let process;
      try {
        process = await this.sandbox.getProcess("opencode-bot-hindsight");
      } catch {
        /* No process on a fresh instance. */
      }
      if (!process || !["running", "starting"].includes(process.status))
        process = await this.sandbox.startProcess(
          "node /opt/opencode-bot/runner/hindsight-service.mjs",
          {
            processId: "opencode-bot-hindsight",
            cwd: "/opt/opencode-bot",
            env: {
              RUNNER_TOKEN: this.options.token,
              HINDSIGHT_SERVICE_PORT: "8790",
            },
          },
        );
      await process.waitForPort(8790, {
        path: "/live",
        status: 200,
        timeout: 30000,
      });
      const origin = await this.options.origin();
      if (!origin)
        throw new MemoryError(
          503,
          "Open this workspace in your browser once to initialize the memory service address.",
        );
      const configured = await this.raw("/configure", {
        method: "POST",
        body: JSON.stringify({
          llmBaseUrl: origin + "/internal/hindsight/ai/v1",
          llmApiKey: await this.options.modelToken(),
          llmModel: "@cf/zai-org/glm-5.3-flash",
        }),
      });
      if (!configured.ok)
        throw new MemoryError(
          503,
          "Hindsight is starting. Memory indexing will retry automatically.",
        );
      const health = await this.raw("/health");
      const value: any = await health.json();
      if (value.instanceId) this.options.instance(value.instanceId);
      if (!health.ok || value.upstreamReady !== true)
        throw new MemoryError(
          503,
          "Hindsight is starting its database and models.",
        );
      this.checkedAt = Date.now();
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private raw(path: string, init: RequestInit = {}) {
    // Cloudflare Sandbox RPC cannot serialize AbortSignal objects. Keep the
    // timeout local to this adapter and send only RPC-serializable RequestInit.
    const { signal: _signal, ...rpcInit } = init;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Hindsight service request timed out")), 120000);
    });
    const request = this.sandbox.containerFetch(
      new URL(path, "http://hindsight:8790").toString(),
      {
        ...rpcInit,
        headers: {
          ...rpcInit.headers,
          "content-type": "application/json",
          authorization: `Bearer ${this.options.token}`,
        },
      },
      8790,
    ) as Promise<Response>;
    return Promise.race([request, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  async fetch(path: string, init: RequestInit = {}) {
    await this.prepare();
    try {
      return await this.raw(path, init);
    } catch (error) {
      this.checkedAt = 0;
      throw error;
    }
  }
}
