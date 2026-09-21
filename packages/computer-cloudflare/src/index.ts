import type { Process, Sandbox } from "@cloudflare/sandbox";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type CheckpointBucket = {
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<{ size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

/** Capabilities are deliberately explicit: a caller must not infer isolation from a provider name. */
export type ComputerCapabilities = {
  os: "linux" | "macos" | "windows";
  shell: boolean;
  desktop: boolean;
  browser: boolean;
  durableDisk: boolean;
  snapshots: boolean;
  enforcedEgress: boolean;
  maxParallelScreens: number;
};

export type ComputerSpec = {
  /** Human/application id. The provider derives the Cloudflare DO key from this value. */
  computerId: string;
  workspacePath?: string;
  runnerPort?: number;
  /** Command is executed by the image's shell and should be pinned by the image build. */
  runnerCommand?: string;
  runnerToken: string;
  /** Persisted by the coordinator; this provider does not invent fencing across restarts. */
  generation?: number;
  /** Extra non-secret environment for the runner. Secrets should normally stay in the broker. */
  runnerEnv?: Record<string, string>;
};

export type RunnerLease = {
  computerId: string;
  generation: number;
  token: string;
};

export type ComputerStatus = {
  id: string;
  state: "ready" | "starting" | "stopped" | "error" | "unknown";
  runner: "ready" | "unavailable" | "unknown";
  generation: number;
  checkedAt: string;
  detail?: string;
};

export type RunnerTransport = {
  readonly computerId: string;
  readonly generation: number;
  /** Requests are scoped to the runner port and carry the lease token. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
};

export type CheckpointManifest = {
  id: string;
  computerId: string;
  createdAt: string;
  supported: boolean;
  durable: boolean;
  /** A provider must never imply that an unsupported checkpoint is restorable. */
  reason?: string;
  checkpointKey?: string;
  sha256?: string;
  bytes?: number;
  paths?: string[];
};

export interface ComputerProvider {
  capabilities(): Promise<ComputerCapabilities>;
  ensure(spec: ComputerSpec, key?: string): Promise<ComputerHandle>;
  inspect(id: string): Promise<ComputerStatus>;
  connect(id: string, lease: RunnerLease): Promise<RunnerTransport>;
  checkpoint(id: string, fence: number): Promise<CheckpointManifest>;
  restore(id: string, checkpoint: CheckpointManifest): Promise<void>;
  stop(id: string, mode: "graceful" | "force"): Promise<void>;
  destroy(id: string): Promise<void>;
}

export type ComputerHandle = {
  id: string;
  generation: number;
  workspacePath: string;
  runnerPort: number;
  status: ComputerStatus;
  transport: RunnerTransport;
};

// Cloudflare's generated DurableObjectNamespace requires an internal brand that
// the public Sandbox class does not expose. `any` keeps the binding compatible
// with wrangler-generated Env types while the returned proxy remains typed.
// Keep this application boundary opaque. Wrangler's generated namespace type
// carries a recursive branded generic that makes ordinary Env assignments hit
// TypeScript's instantiation-depth limit. The only cast is at defaultSandbox().
export type CloudflareSandboxBinding = unknown;

export type CloudflareComputerProviderOptions = {
  sandboxNamespace: CloudflareSandboxBinding;
  /** Keep the interactive runner alive between user requests. Disable only when the caller owns an explicit wake/snapshot lifecycle. */
  keepAlive?: boolean;
  /** Applied when keepAlive is false; otherwise the SDK ignores it. */
  sleepAfter?: string | number;
  defaultRunnerPort?: number;
  defaultRunnerCommand?: string;
  /** The image must provide this path. The adapter does not build or mutate images. */
  defaultWorkspacePath?: string;
  /** Set false only when a separate network policy enforces egress. */
  enforcedEgress?: boolean;
  /** Optional application-owned archive store. Checkpointing stays disabled without it. */
  checkpointBucket?: CheckpointBucket;
  checkpointPrefix?: string;
  /** Paths are archived only after the runner confirms it is quiescent. */
  checkpointPaths?: string[];
  /** Keep the archive below the Worker memory budget while reading binary chunks. */
  maxCheckpointBytes?: number;
  /** Test seam and alternative Sandbox implementations; production defaults to getSandbox. */
  sandboxFactory?: (namespace: CloudflareSandboxBinding, key: string, options?: { keepAlive: boolean; sleepAfter?: string | number }) => Sandbox<unknown>;
};

type ManagedComputer = {
  spec: Required<Pick<ComputerSpec, "runnerPort" | "runnerCommand" | "workspacePath">> & ComputerSpec;
  sandbox: Sandbox<unknown>;
  process?: Process;
  generation: number;
  keepAlive: boolean;
};

const DEFAULT_RUNNER_COMMAND = "node /opt/opencode-bot/runner/server.mjs";
const DEFAULT_WORKSPACE = "/workspace/shared";
// Sandbox's container server owns 3000; the bot runner uses the private image port.
const DEFAULT_PORT = 8787;
// Bound buffering during checkpoint upload and checksum verification.
const DEFAULT_MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
// Chromium rebuilds these files; preserving them adds size without preserving
// user state such as cookies, history, or local storage.
const DEFAULT_CHECKPOINT_EXCLUDES = [
  "/workspace/browser/profile/Default/Cache",
  "/workspace/browser/profile/Default/Code Cache",
  "/workspace/browser/profile/Default/GPUCache",
  "/workspace/browser/profile/Default/DawnGraphiteCache",
  "/workspace/browser/profile/Default/DawnWebGPUCache",
  "/workspace/browser/profile/BrowserMetrics-spare.pma",
];

/**
 * Cloudflare Sandbox implementation.
 *
 * The provider owns lifecycle and a private runner transport. It intentionally does
 * not use @cloudflare/sandbox/opencode: that helper currently targets the old V1
 * SDK and does not qualify an OpenCode 2 runtime.
 */
export class CloudflareComputerProvider implements ComputerProvider {
  private readonly computers = new Map<string, ManagedComputer>();
  private readonly pending = new Map<string, Promise<ComputerHandle>>();

  constructor(private readonly options: CloudflareComputerProviderOptions) {}

  async capabilities(): Promise<ComputerCapabilities> {
    return {
      os: "linux",
      shell: true,
      desktop: false,
      browser: false,
      durableDisk: false,
      snapshots: false,
      enforcedEgress: this.options.enforcedEgress ?? false,
      maxParallelScreens: 0,
    };
  }

  async ensure(spec: ComputerSpec, key = spec.computerId): Promise<ComputerHandle> {
    const pending = this.pending.get(spec.computerId);
    if (pending) return pending;
    const operation = this.ensureManaged(spec, key);
    this.pending.set(spec.computerId, operation);
    try { return await operation; } finally { this.pending.delete(spec.computerId); }
  }

  private async ensureManaged(spec: ComputerSpec, key: string): Promise<ComputerHandle> {
    if (!spec.computerId || !spec.runnerToken) throw new Error("computerId and runnerToken are required");
    const existing = this.computers.get(spec.computerId);
    if (existing) {
      if (existing.keepAlive && typeof existing.sandbox.setKeepAlive === "function") await existing.sandbox.setKeepAlive(true);
      await this.startRunner(existing);
      return this.handle(existing, await this.inspectManaged(existing));
    }

    const sandboxOptions = { keepAlive: this.options.keepAlive ?? true, sleepAfter: this.options.sleepAfter };
    const sandbox = this.options.sandboxFactory?.(this.options.sandboxNamespace, key, sandboxOptions) ?? await defaultSandbox(this.options.sandboxNamespace, key, sandboxOptions);
    const managed: ManagedComputer = {
      spec: {
        ...spec,
        runnerPort: spec.runnerPort ?? this.options.defaultRunnerPort ?? DEFAULT_PORT,
        runnerCommand: spec.runnerCommand ?? this.options.defaultRunnerCommand ?? DEFAULT_RUNNER_COMMAND,
        workspacePath: spec.workspacePath ?? this.options.defaultWorkspacePath ?? DEFAULT_WORKSPACE,
      },
      sandbox,
      generation: spec.generation ?? 1,
      keepAlive: sandboxOptions.keepAlive,
    };
    this.computers.set(spec.computerId, managed);
    try {
      await this.startRunner(managed);
      return this.handle(managed, await this.inspectManaged(managed));
    } catch (error) {
      this.computers.delete(spec.computerId);
      throw error;
    }
  }

  async inspect(id: string): Promise<ComputerStatus> {
    const managed = this.computers.get(id);
    if (!managed) {
      return {
        id,
        state: "unknown",
        runner: "unknown",
        generation: 0,
        checkedAt: new Date().toISOString(),
        detail: "Computer has not been ensured in this provider instance",
      };
    }
    return this.inspectManaged(managed);
  }

  async connect(id: string, lease: RunnerLease): Promise<RunnerTransport> {
    const managed = this.computers.get(id);
    if (!managed) throw new Error(`Unknown computer: ${id}`);
    if (lease.computerId !== id) throw new Error("Lease computer does not match transport computer");
    if (lease.generation !== managed.generation) throw new Error("Stale computer lease generation");
    if (!lease.token) throw new Error("Runner lease token is required");
    return this.transport(managed, lease.generation, lease.token);
  }

  async checkpoint(id: string, _fence: number): Promise<CheckpointManifest> {
    const managed = this.computers.get(id);
    if (!managed) throw new Error(`Unknown computer: ${id}`);
    const bucket = this.options.checkpointBucket;
    if (bucket) {
      const transport = this.transport(managed, managed.generation, managed.spec.runnerToken);
      const quiesced = await transport.fetch("/checkpoint/quiesce", { method: "POST" });
      if (!quiesced.ok) {
        throw new Error(`Runner refused checkpoint quiesce (HTTP ${quiesced.status})`);
      }
      const paths = this.options.checkpointPaths ?? ["/workspace/state", managed.spec.workspacePath, "/workspace/browser"];
      validateCheckpointPaths(paths, managed.spec.workspacePath);
      const archiveName = `/tmp/opencode-bot-checkpoint-${safeId(id)}.tar.gz`;
      let checkpointFailure: unknown;
      try {
        const archive = await managed.sandbox.exec(
          `tar -czf ${shellQuote(archiveName)} ${DEFAULT_CHECKPOINT_EXCLUDES.map((path) => `--exclude=${shellQuote(path.replace(/^\/+/, ""))}`).join(" ")} -C / ${paths.map((path) => shellQuote(path.replace(/^\/+/, ""))).join(" ")}`,
        );
        if (!archive.success) throw new Error(`Checkpoint archive failed: ${archive.stderr || archive.stdout}`);
        const maxBytes = this.options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
        const size = await archiveSize(managed.sandbox, archiveName);
        if (size > maxBytes) throw new Error(`Checkpoint archive is ${size} bytes; maximum is ${maxBytes}`);
        const bytes = await readArchiveBytes(managed.sandbox, archiveName, maxBytes);
        const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
        const sha256 = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
        const checkpointId = `${id}:${managed.generation}:${Date.now()}`;
        const key = `${this.options.checkpointPrefix ?? "checkpoints"}/${safeId(id)}/${checkpointId.replaceAll(":", "-")}.tar.gz`;
        await bucket.put(key, bytes, { httpMetadata: { contentType: "application/gzip" }, customMetadata: { computerId: id, sha256 } });
        return { id: checkpointId, computerId: id, createdAt: new Date().toISOString(), supported: true, durable: true, checkpointKey: key, sha256, bytes: bytes.byteLength, paths };
      } catch (error) {
        checkpointFailure = error;
        throw error;
      } finally {
        const resumed = await transport.fetch("/checkpoint/resume", { method: "POST" }).catch((error) => ({ ok: false, status: 0, error } as const));
        if (!resumed.ok) {
          const reason = "error" in resumed ? String(resumed.error) : `HTTP ${resumed.status}`;
          throw new Error(`Runner failed to resume after checkpoint${checkpointFailure ? ` (${String(checkpointFailure)})` : ""}: ${reason}`);
        }
        await managed.sandbox.exec(`rm -f ${shellQuote(archiveName)}`).catch(() => undefined);
      }
    }
    // A raw Sandbox disk is ephemeral. Without a quiescing runner and an
    // application-owned R2 archive, claiming durability would be misleading.
    return {
      id: `${id}:${managed.generation}:${Date.now()}`,
      computerId: id,
      createdAt: new Date().toISOString(),
      supported: false,
      durable: false,
      reason: "Cloudflare Sandbox working disk is ephemeral; no quiesced R2 checkpoint adapter is configured",
    };
  }

  async restore(id: string, checkpoint: CheckpointManifest): Promise<void> {
    if (!checkpoint.supported || !checkpoint.durable) {
      throw new Error(`Checkpoint ${checkpoint.id} is not restorable: ${checkpoint.reason ?? "unsupported"}`);
    }
    const managed = this.computers.get(id);
    const bucket = this.options.checkpointBucket;
    if (!managed || !bucket || !checkpoint.checkpointKey) throw new Error("R2 checkpoint restore is not configured for this provider");
    const object = await bucket.get(checkpoint.checkpointKey);
    if (!object) throw new Error(`Checkpoint object not found: ${checkpoint.checkpointKey}`);
    const maxBytes = this.options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    if (typeof object.size !== "number" || !Number.isFinite(object.size) || object.size < 0) throw new Error("Checkpoint object does not expose a trusted size");
    if (object.size > maxBytes) throw new Error(`Checkpoint object is ${object.size} bytes; maximum is ${maxBytes}`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
    if (checkpoint.sha256 && checkpoint.sha256 !== sha256) throw new Error("Checkpoint checksum mismatch");
    const archiveName = `/tmp/opencode-bot-restore-${safeId(id)}.tar.gz`;
    const transport = this.transport(managed, managed.generation, managed.spec.runnerToken);
    const quiesced = await transport.fetch("/checkpoint/quiesce", { method: "POST" });
    if (!quiesced.ok) throw new Error(`Runner refused restore quiesce (HTTP ${quiesced.status})`);
    const content = toBase64(bytes);
    try {
      const written = await managed.sandbox.writeFile(archiveName, content, { encoding: "base64" });
      if (!written.success) throw new Error(`Could not write checkpoint archive: ${archiveName}`);
      const roots = checkpoint.paths ?? ["/workspace/state", managed.spec.workspacePath, "/workspace/browser"];
      validateCheckpointPaths(roots, managed.spec.workspacePath);
      const listing = await managed.sandbox.exec(`tar -tzf ${shellQuote(archiveName)}`);
      if (!listing.success) throw new Error(`Could not verify checkpoint archive: ${listing.stderr || listing.stdout}`);
      validateArchiveListing(listing.stdout, roots);
      // Restore is explicit and runs only behind the runner's quiesce barrier.
      // Remove the archived roots first so deleted files do not survive as
      // stale state after extraction.
      const reset = await managed.sandbox.exec(`${roots.map((root) => `rm -rf ${shellQuote(root)} && mkdir -p ${shellQuote(root)}`).join(" && ")}`);
      if (!reset.success) throw new Error(`Could not prepare checkpoint roots: ${reset.stderr || reset.stdout}`);
      const result = await managed.sandbox.exec(`tar -xzf ${shellQuote(archiveName)} -C /`);
      if (!result.success) throw new Error(`Checkpoint restore failed: ${result.stderr || result.stdout}`);
    } finally {
      await managed.sandbox.exec(`rm -f ${shellQuote(archiveName)}`).catch(() => undefined);
      const resumed = await transport.fetch("/checkpoint/resume", { method: "POST" }).catch((error) => ({ ok: false, status: 0, error } as const));
      if (!resumed.ok) {
        const reason = "error" in resumed ? String(resumed.error) : `HTTP ${resumed.status}`;
        throw new Error(`Runner failed to resume after restore: ${reason}`);
      }
    }
  }

  async stop(id: string, mode: "graceful" | "force"): Promise<void> {
    const managed = this.computers.get(id);
    if (!managed) return;
    if (managed.process) {
      await managed.process.kill(mode === "graceful" ? "SIGTERM" : "SIGKILL").catch(() => undefined);
      managed.process = undefined;
    }
    // keepAlive intentionally pins the container during normal operation;
    // stopping the computer must release that pin or the SDK will continue
    // heartbeating an otherwise idle container.
    if (managed.keepAlive && typeof managed.sandbox.setKeepAlive === "function") await managed.sandbox.setKeepAlive(false).catch(() => undefined);
    if (mode === "force") await managed.sandbox.stop("SIGKILL").catch(() => undefined);
  }

  async destroy(id: string): Promise<void> {
    const managed = this.computers.get(id);
    if (!managed) return;
    this.computers.delete(id);
    await managed.sandbox.destroy();
  }

  private async startRunner(managed: ManagedComputer): Promise<void> {
    const { spec, sandbox } = managed;
    // containerFetch waits for the destination port to become ready. Calling
    // it before starting the runner deadlocks a cold computer. Inspect the
    // Sandbox process registry (port 3000) instead.
    const current = await sandbox.getProcess('opencode-bot-runner');
    if (current && (current.status === 'running' || current.status === 'starting')) {
      managed.process = current;
      await current.waitForPort(spec.runnerPort, { path: '/health', status: 200, timeout: 30000 });
      return;
    }
    managed.process = await sandbox.startProcess(spec.runnerCommand.trim(), {
      processId: 'opencode-bot-runner',
      cwd: spec.workspacePath,
      env: {
        ...spec.runnerEnv,
        RUNNER_PORT: String(spec.runnerPort),
        RUNNER_TOKEN: spec.runnerToken,
        WORKSPACE_DIRECTORY: spec.workspacePath,
      },
    });
    await managed.process.waitForPort(spec.runnerPort, { path: "/health", status: 200, timeout: 30000 });
  }

  private async inspectManaged(managed: ManagedComputer): Promise<ComputerStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.runnerRequest(managed, "/health", { method: "GET" });
      return {
        id: managed.spec.computerId,
        state: response.ok ? "ready" : "starting",
        runner: response.ok ? "ready" : "unavailable",
        generation: managed.generation,
        checkedAt,
        detail: response.ok ? undefined : `runner health returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        id: managed.spec.computerId,
        state: managed.process ? "starting" : "unknown",
        runner: "unavailable",
        generation: managed.generation,
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private handle(managed: ManagedComputer, status: ComputerStatus): ComputerHandle {
    return {
      id: managed.spec.computerId,
      generation: managed.generation,
      workspacePath: managed.spec.workspacePath,
      runnerPort: managed.spec.runnerPort,
      status,
      transport: this.transport(managed, managed.generation, managed.spec.runnerToken),
    };
  }

  private transport(managed: ManagedComputer, generation: number, token: string): RunnerTransport {
    return {
      computerId: managed.spec.computerId,
      generation,
      fetch: async (path, init = {}) => {
        if (generation !== managed.generation) throw new Error("Stale computer transport generation");
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("X-Computer-Generation", String(generation));
        return this.runnerRequest(managed, path, { ...init, headers });
      },
    };
  }

  private async runnerRequest(managed: ManagedComputer, path: string, init: RequestInit): Promise<Response> {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = `http://127.0.0.1${normalized}`;
    return managed.sandbox.containerFetch(url, init, managed.spec.runnerPort);
  }
}

async function defaultSandbox(namespace: CloudflareSandboxBinding, key: string, options: { keepAlive: boolean; sleepAfter?: string | number }): Promise<Sandbox<unknown>> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  // The generated DurableObjectNamespace brand is intentionally hidden by
  // Cloudflare's public Sandbox type. Keep the cast at this boundary rather
  // than leaking the branded generic through the application contract.
  const factory = getSandbox as unknown as (binding: DurableObjectNamespace<any>, id: string, options?: { keepAlive?: boolean; sleepAfter?: string | number }) => Sandbox<unknown>;
  // The runner is an interactive, long-lived process. Sandbox's default
  // sleepAfter is 10 minutes of request inactivity, which stops the container
  // even while the process is alive and loses its ephemeral filesystem. Keep
  // it alive until the provider's explicit destroy/stop lifecycle runs.
  return factory(namespace as DurableObjectNamespace<any>, key, options);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "computer";
}

function toBase64(bytes: Uint8Array): string {
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(output);
}

async function archiveSize(sandbox: Sandbox<unknown>, archiveName: string): Promise<number> {
  const result = await sandbox.exec(`stat -c %s ${shellQuote(archiveName)}`);
  if (!result.success) throw new Error(`Could not measure checkpoint archive: ${result.stderr || result.stdout}`);
  const size = Number(result.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Checkpoint archive returned an invalid size");
  return size;
}

async function readArchiveBytes(sandbox: Sandbox<unknown>, archiveName: string, maxBytes: number): Promise<Uint8Array> {
  // Raw RPC streams avoid the transient base64 and decoded JS strings. Some
  // Sandbox transports do not support `none`, so retain the bounded fallback.
  try {
    const streamed = await sandbox.readFile(archiveName, { encoding: "none" });
    if (streamed.size > maxBytes) throw new Error(`Checkpoint archive is ${streamed.size} bytes; maximum is ${maxBytes}`);
    const reader = streamed.content.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) throw new Error(`Checkpoint archive is ${total} bytes; maximum is ${maxBytes}`);
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    // The HTTP/WebSocket Sandbox transports reject encoding `none`; only fall
    // back for that transport limitation, while preserving size/read errors.
    if (!(error instanceof Error) || !/encoding|stream|getReader|rpc|transport|unsupported/i.test(error.message)) throw error;
  }
  const bytesResult = await sandbox.readFile(archiveName, { encoding: "base64" });
  if (!bytesResult.success) throw new Error(`Checkpoint archive read failed for ${archiveName}`);
  const decodedLength = Math.floor(bytesResult.content.length * 3 / 4) - (bytesResult.content.endsWith("==") ? 2 : bytesResult.content.endsWith("=") ? 1 : 0);
  if (decodedLength > maxBytes) throw new Error(`Checkpoint archive is ${decodedLength} bytes; maximum is ${maxBytes}`);
  const bytes = Uint8Array.from(atob(bytesResult.content), (char) => char.charCodeAt(0));
  if (bytes.byteLength > maxBytes) throw new Error(`Checkpoint archive is ${bytes.byteLength} bytes; maximum is ${maxBytes}`);
  return bytes;
}

function validateCheckpointPaths(paths: string[], workspacePath: string): void {
  const allowed = ["/workspace/state", "/workspace/browser", workspacePath];
  for (const path of paths) {
    if (!path.startsWith("/workspace/") || path === "/workspace/" || path.includes("/../") || path.endsWith("/..") || path.includes("//")) {
      throw new Error(`Refusing unsafe checkpoint path: ${path}`);
    }
    if (!allowed.some((root) => path === root || path.startsWith(`${root}/`))) throw new Error(`Refusing unknown checkpoint path: ${path}`);
  }
}

function validateArchiveListing(listing: string, roots: string[]): void {
  const relativeRoots = roots.map((root) => root.replace(/^\/+/, "").replace(/\/+$/, ""));
  for (const rawEntry of listing.split(/\r?\n/)) {
    const entry = rawEntry.trim().replace(/^\/+/, "");
    if (!entry) continue;
    if (entry.startsWith("../") || entry.includes("/../") || entry === ".." || entry.includes("\\")) throw new Error(`Checkpoint archive contains unsafe path: ${rawEntry}`);
    if (!relativeRoots.some((root) => entry === root || entry.startsWith(`${root}/`))) throw new Error(`Checkpoint archive contains path outside configured roots: ${rawEntry}`);
  }
}

export class UnsupportedCheckpointError extends Error {
  override name = "UnsupportedCheckpointError";
}
