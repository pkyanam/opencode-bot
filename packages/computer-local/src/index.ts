import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  computerId: string;
  workspacePath?: string;
  runnerPort?: number;
  runnerCommand?: string;
  runnerToken: string;
  generation?: number;
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
  fetch(path: string, init?: RequestInit): Promise<Response>;
};
export type CheckpointManifest = {
  id: string;
  computerId: string;
  createdAt: string;
  supported: boolean;
  durable: boolean;
  reason?: string;
  checkpointKey?: string;
  sha256?: string;
  bytes?: number;
  paths?: string[];
};
export type ComputerHandle = {
  id: string;
  generation: number;
  workspacePath: string;
  runnerPort: number;
  status: ComputerStatus;
  transport: RunnerTransport;
};
export type ComputerProvider = {
  capabilities(): Promise<ComputerCapabilities>;
  ensure(spec: ComputerSpec, key?: string): Promise<ComputerHandle>;
  inspect(id: string): Promise<ComputerStatus>;
  connect(id: string, lease: RunnerLease): Promise<RunnerTransport>;
  checkpoint(id: string, fence: number): Promise<CheckpointManifest>;
  restore(id: string, checkpoint: CheckpointManifest): Promise<void>;
  isRunning?(id: string): Promise<boolean>;
  stop(id: string, mode: "graceful" | "force"): Promise<void>;
  destroy(id: string): Promise<void>;
};

/** A local object store may consume a web stream, keeping checkpoint memory bounded. */
export type LocalObjectStore = {
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    size?: number;
    body?: ReadableStream<Uint8Array> | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  } | null>;
  head?(key: string): Promise<{ size?: number } | null>;
};
type Managed = {
  id: string;
  spec: Required<
    Pick<ComputerSpec, "workspacePath" | "runnerPort" | "runnerCommand">
  > &
    ComputerSpec;
  generation: number;
  runtimeDir: string;
  process?: Spawned;
  processError?: Error;
  stopRequested?: boolean;
};
type Spawned = Pick<
  import("node:child_process").ChildProcess,
  "kill" | "once" | "on"
> & {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
};

export type LocalComputerProviderOptions = {
  dataDir: string;
  /** Default application workspace when a ComputerSpec omits workspacePath. */
  workspacePath?: string;
  runnerScript?: string;
  runnerCommand?: string;
  runnerPort?: number;
  checkpointStore?: LocalObjectStore;
  checkpointPrefix?: string;
  checkpointPaths?: string[];
  maxCheckpointBytes?: number;
  enforcedEgress?: boolean;
  fetch?: typeof globalThis.fetch;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore" | "pipe" },
  ) => Spawned;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_MAX = 2 * 1024 * 1024 * 1024;
const DEFAULT_COMMAND = "node";
const DEFAULT_SCRIPT = path.resolve(process.cwd(), "runner/server.mjs");
const EXCLUDES = [
  "browser/profile/Default/Cache",
  "browser/profile/Default/Code Cache",
  "browser/profile/Default/GPUCache",
  "browser/profile/Default/DawnGraphiteCache",
  "browser/profile/Default/DawnWebGPUCache",
  "browser/profile/BrowserMetrics-spare.pma",
];

export class LocalComputerProvider implements ComputerProvider {
  private readonly computers = new Map<string, Managed>();
  private readonly pending = new Map<string, Promise<ComputerHandle>>();
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: LocalComputerProviderOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async capabilities(): Promise<ComputerCapabilities> {
    return {
      os: "linux",
      shell: true,
      desktop: true,
      browser: true,
      durableDisk: true,
      snapshots: Boolean(this.options.checkpointStore),
      enforcedEgress: this.options.enforcedEgress ?? false,
      maxParallelScreens: 1,
    };
  }
  async ensure(
    spec: ComputerSpec,
    key = spec.computerId,
  ): Promise<ComputerHandle> {
    if (!spec.computerId || !spec.runnerToken)
      throw new Error("computerId and runnerToken are required");
    const current = this.pending.get(spec.computerId);
    if (current) return current;
    const op = this.ensureManaged(spec, key);
    this.pending.set(spec.computerId, op);
    try {
      return await op;
    } finally {
      this.pending.delete(spec.computerId);
    }
  }
  private async ensureManaged(
    spec: ComputerSpec,
    key: string,
  ): Promise<ComputerHandle> {
    let managed = this.computers.get(spec.computerId);
    if (!managed) {
      const runtimeDir = path.join(
        this.options.dataDir,
        "computers",
        safeId(key),
      );
      const workspacePath =
        spec.workspacePath ??
        this.options.workspacePath ??
        path.join(runtimeDir, "workspace");
      // The local adapter owns its entrypoint. Cloudflare image commands must
      // never be interpreted as shell text on the Boat host.
      managed = {
        id: spec.computerId,
        spec: {
          ...spec,
          workspacePath,
          runnerPort: spec.runnerPort ?? this.options.runnerPort ?? 0,
          runnerCommand: this.options.runnerCommand ?? DEFAULT_COMMAND,
        },
        generation: spec.generation ?? 1,
        runtimeDir,
      };
      this.computers.set(spec.computerId, managed);
    } else if (
      spec.generation !== undefined &&
      spec.generation !== managed.generation
    )
      managed.generation = spec.generation;
    await mkdir(managed.runtimeDir, { recursive: true });
    await mkdir(managed.spec.workspacePath, { recursive: true });
    await this.start(managed);
    return this.handle(managed, await this.inspectManaged(managed));
  }
  async inspect(id: string): Promise<ComputerStatus> {
    const m = this.computers.get(id);
    if (!m)
      return {
        id,
        state: "unknown",
        runner: "unknown",
        generation: 0,
        checkedAt: new Date().toISOString(),
        detail: "Computer has not been ensured in this provider instance",
      };
    return this.inspectManaged(m);
  }
  async connect(id: string, lease: RunnerLease): Promise<RunnerTransport> {
    const m = this.computers.get(id);
    if (!m) throw new Error(`Unknown computer: ${id}`);
    if (lease.computerId !== id)
      throw new Error("Lease computer does not match transport computer");
    if (lease.generation !== m.generation)
      throw new Error("Stale computer lease generation");
    if (!lease.token) throw new Error("Runner lease token is required");
    return this.transport(m, lease.generation, lease.token);
  }
  async isRunning(id: string): Promise<boolean> {
    const m = this.computers.get(id);
    return Boolean(m?.process && !hasExited(m.process));
  }
  async stop(id: string, mode: "graceful" | "force"): Promise<void> {
    const m = this.computers.get(id);
    if (!m?.process) return;
    if (mode === "graceful")
      await this.request(m, "/checkpoint/quiesce", { method: "POST" }).catch(
        () => undefined,
      );
    const p = m.process;
    m.stopRequested = true;
    if (!hasExited(p)) p.kill(mode === "graceful" ? "SIGTERM" : "SIGKILL");
    await waitExit(p, 10_000).catch(() => undefined);
    if (!hasExited(p)) {
      p.kill("SIGKILL");
      await waitExit(p, 2_000).catch(() => undefined);
    }
    if (!hasExited(p)) throw new Error(`Runner ${id} did not stop`);
    m.process = undefined;
  }
  async destroy(id: string): Promise<void> {
    const m = this.computers.get(id);
    if (!m) return;
    await this.stop(id, "force");
    this.computers.delete(id);
    await rm(m.runtimeDir, { recursive: true, force: true });
  }
  async checkpoint(id: string, _fence: number): Promise<CheckpointManifest> {
    const m = this.computers.get(id);
    if (!m) throw new Error(`Unknown computer: ${id}`);
    const store = this.options.checkpointStore;
    if (!store)
      return {
        id: `${id}:${m.generation}:${Date.now()}`,
        computerId: id,
        createdAt: new Date().toISOString(),
        supported: false,
        durable: false,
        reason: "Local checkpoint object store is not configured",
      };
    const quiesced = await this.request(m, "/checkpoint/quiesce", {
      method: "POST",
    });
    if (!quiesced.ok)
      throw new Error(
        `Runner refused checkpoint quiesce (HTTP ${quiesced.status})`,
      );
    const archive = path.join(
      m.runtimeDir,
      `checkpoint-${Date.now()}-${randomUUID()}.tar.gz`,
    );
    let failure: unknown;
    try {
      const paths = this.options.checkpointPaths ?? [
        path.join(m.runtimeDir, "state"),
        m.spec.workspacePath,
      ];
      validatePaths(paths, m.spec.workspacePath);
      await runTar(archive, paths, EXCLUDES);
      const metadata = await fileDigest(archive);
      const max = this.options.maxCheckpointBytes ?? DEFAULT_MAX;
      if (metadata.bytes > max)
        throw new Error(
          `Checkpoint archive is ${metadata.bytes} bytes; maximum is ${max}`,
        );
      const key = `${this.options.checkpointPrefix ?? "checkpoints"}/${safeId(id)}/${id}-${m.generation}-${Date.now()}.tar.gz`;
      const stream = Readable.toWeb(
        createReadStream(archive),
      ) as ReadableStream<Uint8Array>;
      await store.put(key, stream, {
        contentType: "application/gzip",
        computerId: id,
        sha256: metadata.sha256,
      });
      return {
        id: `${id}:${m.generation}:${Date.now()}`,
        computerId: id,
        createdAt: new Date().toISOString(),
        supported: true,
        durable: true,
        checkpointKey: key,
        sha256: metadata.sha256,
        bytes: metadata.bytes,
        paths,
      };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
      const resumed = await this.request(m, "/checkpoint/resume", {
        method: "POST",
      }).catch(() => undefined);
      if (!resumed?.ok)
        throw new Error(
          `Runner failed to resume after checkpoint${failure ? ` (${String(failure)})` : ""}`,
        );
    }
  }
  async restore(id: string, checkpoint: CheckpointManifest): Promise<void> {
    if (
      !checkpoint.supported ||
      !checkpoint.durable ||
      !checkpoint.checkpointKey
    )
      throw new Error(
        `Checkpoint ${checkpoint.id} is not restorable: ${checkpoint.reason ?? "unsupported"}`,
      );
    const m = this.computers.get(id);
    const store = this.options.checkpointStore;
    if (!m || !store)
      throw new Error("Local checkpoint restore is not configured");
    const object = await store.get(checkpoint.checkpointKey);
    if (!object)
      throw new Error(
        `Checkpoint object not found: ${checkpoint.checkpointKey}`,
      );
    const max = this.options.maxCheckpointBytes ?? DEFAULT_MAX;
    if (object.size !== undefined && object.size > max)
      throw new Error(
        `Checkpoint object is ${object.size} bytes; maximum is ${max}`,
      );
    const quiesced = await this.request(m, "/checkpoint/quiesce", {
      method: "POST",
    });
    if (!quiesced.ok)
      throw new Error(
        `Runner refused restore quiesce (HTTP ${quiesced.status})`,
      );
    try {
      await this.stop(id, "graceful");
    } catch (error) {
      await this.request(m, "/checkpoint/resume", { method: "POST" }).catch(
        () => undefined,
      );
      throw error;
    }
    const archive = path.join(
      m.runtimeDir,
      `restore-${Date.now()}-${randomUUID()}.tar.gz`,
    );
    let failure: unknown;
    try {
      await writeObject(object, archive, max);
      const digest = await fileDigest(archive);
      if (checkpoint.sha256 && checkpoint.sha256 !== digest.sha256)
        throw new Error("Checkpoint checksum mismatch");
      const roots = checkpoint.paths ?? [
        path.join(m.runtimeDir, "state"),
        m.spec.workspacePath,
      ];
      validatePaths(roots, m.spec.workspacePath);
      await verifyArchive(archive, roots);
      await extractAtomic(archive, roots, m.runtimeDir);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
      try {
        await this.start(m);
      } catch (restartError) {
        throw new Error(
          `Runner failed to restart after restore${failure ? ` (${String(failure)})` : ""}: ${String(restartError)}`,
        );
      }
    }
  }
  private async start(m: Managed): Promise<void> {
    if (m.process && !hasExited(m.process)) {
      await this.waitHealth(m);
      return;
    }
    const port = m.spec.runnerPort || (await freePort());
    m.spec.runnerPort = port;
    const nonce = randomUUID();
    const display = m.spec.runnerEnv?.DISPLAY ?? process.env.DISPLAY ?? ":0";
    const cdp =
      m.spec.runnerEnv?.OPENCODE_BOT_CDP_ENDPOINT ??
      process.env.OPENCODE_BOT_CDP_ENDPOINT ??
      "http://127.0.0.1:9222";
    const env = {
      ...process.env,
      ...m.spec.runnerEnv,
      DISPLAY: display,
      OPENCODE_BOT_EXTERNAL_DISPLAY: "1",
      OPENCODE_BOT_CDP_ENDPOINT: cdp,
      RUNNER_PORT: String(port),
      RUNNER_HOST: "127.0.0.1",
      RUNNER_TOKEN: m.spec.runnerToken,
      WORKSPACE_DIRECTORY: m.spec.workspacePath,
      OPENCODE_DIRECTORY: m.spec.workspacePath,
      RUNTIME_ROOT: path.join(m.runtimeDir, "state"),
      BOT_TOOLS_URL: `http://127.0.0.1:${port}/bot-tools`,
      NODE_RUNNER_STARTUP_NONCE: nonce,
    };
    const command = m.spec.runnerCommand ?? DEFAULT_COMMAND;
    if (/\s/.test(command))
      throw new Error(
        "Local runner command must be an executable; configure runnerScript for the pinned runner entrypoint",
      );
    const args = [this.options.runnerScript ?? DEFAULT_SCRIPT];
    let childProcess: Spawned;
    try {
      childProcess = (this.options.spawn ?? defaultSpawn)(command, args, {
        cwd: m.spec.workspacePath,
        env,
        stdio: "ignore",
      });
    } catch (error) {
      throw new Error(`Could not spawn runner: ${String(error)}`);
    }
    m.process = childProcess;
    m.processError = undefined;
    childProcess.once("error", (error: Error) => {
      m.processError = error;
    });
    (m as Managed & { startupNonce?: string }).startupNonce = nonce;
    await this.waitHealth(m);
  }
  private async waitHealth(m: Managed): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    let last: unknown;
    while (Date.now() < deadline) {
      if (m.processError)
        throw new Error(`Runner process failed: ${m.processError.message}`);
      if (!m.process || hasExited(m.process))
        throw new Error(`Runner exited while starting computer ${m.id}`);
      try {
        const response = await this.request(m, "/health");
        if (response.ok) return;
        last = new Error(`HTTP ${response.status}`);
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Runner health check timed out for ${m.id}: ${String(last ?? "unavailable")}`,
    );
  }
  private async inspectManaged(m: Managed): Promise<ComputerStatus> {
    const checkedAt = new Date().toISOString();
    if (!m.process || hasExited(m.process))
      return {
        id: m.id,
        state: "stopped",
        runner: "unavailable",
        generation: m.generation,
        checkedAt,
      };
    try {
      const response = await this.request(m, "/health");
      return {
        id: m.id,
        state: response.ok ? "ready" : "starting",
        runner: response.ok ? "ready" : "unavailable",
        generation: m.generation,
        checkedAt,
        detail: response.ok
          ? undefined
          : `runner health returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        id: m.id,
        state: "starting",
        runner: "unavailable",
        generation: m.generation,
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  private handle(m: Managed, status: ComputerStatus): ComputerHandle {
    return {
      id: m.id,
      generation: m.generation,
      workspacePath: m.spec.workspacePath,
      runnerPort: m.spec.runnerPort,
      status,
      transport: this.transport(m, m.generation, m.spec.runnerToken),
    };
  }
  private transport(
    m: Managed,
    generation: number,
    token: string,
  ): RunnerTransport {
    return {
      computerId: m.id,
      generation,
      fetch: async (requestPath, init = {}) => {
        if (generation !== m.generation)
          throw new Error("Stale computer transport generation");
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("X-Computer-Generation", String(generation));
        return this.request(m, requestPath, { ...init, headers });
      },
    };
  }
  private request(
    m: Managed,
    requestPath: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${m.spec.runnerToken}`);
    const nonce = (m as Managed & { startupNonce?: string }).startupNonce;
    if (nonce) headers.set("X-Opencode-Startup-Nonce", nonce);
    const signal =
      init.signal ??
      AbortSignal.timeout(this.options.requestTimeoutMs ?? 5_000);
    return this.fetcher(
      `http://127.0.0.1:${m.spec.runnerPort}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`,
      { ...init, headers, signal },
    );
  }
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore" | "pipe" },
): Spawned {
  return nodeSpawn(command, args, options) as Spawned;
}
function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "computer";
}
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
async function waitExit(process: Spawned, timeout: number): Promise<void> {
  if (hasExited(process)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("process stop timed out")),
      timeout,
    );
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
function hasExited(process: Spawned): boolean {
  return process.exitCode !== null || process.signalCode != null;
}
async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          ),
    );
  });
}
async function runTar(
  archive: string,
  roots: string[],
  excludes: string[],
): Promise<void> {
  const args = [
    "-czf",
    archive,
    ...excludes.flatMap((item) => ["--exclude", item]),
  ];
  for (const root of roots)
    args.push("-C", path.dirname(root), path.basename(root));
  await runCommand("tar", args, "/");
}
async function extractAtomic(
  archive: string,
  roots: string[],
  runtimeDir: string,
): Promise<void> {
  const stage = path.join(runtimeDir, `.restore-stage-${randomUUID()}`);
  const backup = path.join(runtimeDir, `.restore-backup-${randomUUID()}`);
  const moved: Array<{ root: string; old: string }> = [];
  const installed: string[] = [];
  let rollbackError: unknown;
  try {
    await mkdir(stage, { recursive: true });
    for (const root of roots) {
      const label = path.basename(root);
      await runCommand("tar", ["-xzf", archive, "-C", stage, label], stage);
    }
    await mkdir(backup, { recursive: true });
    for (const root of roots) {
      const old = path.join(backup, path.basename(root));
      await mkdir(path.dirname(root), { recursive: true });
      try {
        await rename(root, old);
        moved.push({ root, old });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const root of roots) {
      await rename(path.join(stage, path.basename(root)), root);
      installed.push(root);
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    for (const root of installed)
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    for (const item of moved.reverse()) {
      try {
        await rename(item.old, item.root);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    if (rollbackError)
      throw new Error(
        `Restore failed and rollback is incomplete; backup retained at ${backup}: ${String(rollbackError)}`,
      );
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (!rollbackError)
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}
async function fileDigest(
  filename: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}
async function writeObject(
  object: NonNullable<Awaited<ReturnType<LocalObjectStore["get"]>>>,
  filename: string,
  max: number,
): Promise<void> {
  const output = createWriteStream(filename, { mode: 0o600 });
  let bytes = 0;
  if (object.body) {
    for await (const chunk of Readable.fromWeb(object.body as any)) {
      const data = Buffer.from(chunk as Uint8Array);
      bytes += data.length;
      if (bytes > max)
        throw new Error(`Checkpoint object exceeds maximum of ${max}`);
      if (!output.write(data))
        await new Promise<void>((resolve) =>
          output.once("drain", () => resolve()),
        );
    }
  } else if (object.arrayBuffer) {
    const data = Buffer.from(await object.arrayBuffer());
    if (data.length > max)
      throw new Error(`Checkpoint object exceeds maximum of ${max}`);
    output.write(data);
    bytes = data.length;
  } else throw new Error("Checkpoint object has no body");
  await new Promise<void>((resolve, reject) => {
    output.end(() => resolve());
    output.once("error", reject);
  });
}
async function verifyArchive(archive: string, roots: string[]): Promise<void> {
  const allowed = roots.map((root) => path.basename(root));
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn("tar", ["-tzf", archive], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0)
        return reject(new Error("Could not verify checkpoint archive"));
      for (const entry of output.split("\n").filter(Boolean)) {
        if (
          entry.startsWith("/") ||
          entry.split("/").includes("..") ||
          !allowed.some(
            (root) => entry === root || entry.startsWith(`${root}/`),
          )
        )
          return reject(
            new Error("Checkpoint archive contains an unsafe path"),
          );
      }
      resolve();
    });
  });
}
function validatePaths(paths: string[], workspace: string): void {
  for (const value of paths) {
    if (
      !value.startsWith("/") ||
      value.includes("\0") ||
      value.split("/").includes("..")
    )
      throw new Error(`Unsafe checkpoint path: ${value}`);
  }
  if (
    !paths.some(
      (value) => value === workspace || value.startsWith(`${workspace}/`),
    )
  )
    throw new Error("Checkpoint paths must include the runner workspace");
}
