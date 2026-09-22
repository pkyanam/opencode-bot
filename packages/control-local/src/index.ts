import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { mkdir, stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openLocalStorage,
  LocalObjectStore,
  type LocalStorage,
} from "../../platform-local/src/index.ts";
import {
  LocalComputerProvider,
  type ComputerProvider,
} from "../../computer-local/src/index.ts";
import { LocalHindsight } from "../../../apps/control-worker/src/hindsight-local.ts";
import type { BoatUpdater } from "./boat-updater.ts";
export { BoatUpdater, verifyBundle } from "./boat-updater.ts";

export type LocalEnv = Record<string, unknown> & {
  APP_TOKEN?: string;
  RUNNER_TOKEN?: string;
  APP_UPDATER?: BoatUpdater;
  ASSETS?: Fetcher;
  WORKSPACE: DurableObjectNamespace;
};

export type WorkspaceConstructor = new (
  state: DurableObjectState,
  env: LocalEnv,
) => {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
};

export type LocalControlOptions = {
  host?: string;
  port?: number;
  databasePath: string;
  objectStorePath?: string;
  assetsPath?: string;
  appToken?: string;
  runnerToken?: string;
  appTokenFile?: string;
  runnerTokenFile?: string;
  env?: Record<string, unknown>;
  /** Inject the actual Workspace class and local computer provider wiring. */
  workspace?: WorkspaceConstructor;
  workspaceFactory?: (
    state: DurableObjectState,
    env: LocalEnv,
  ) => { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> };
  worker?: { fetch(request: Request, env: LocalEnv): Promise<Response> };
  computerProvider?: ComputerProvider;
  computerDataDir?: string;
  workspacePath?: string;
  runnerScript?: string;
  hindsightToken?: string;
  hindsightBaseUrl?: string;
  hindsightLlmBaseUrl?: string;
  hindsightLlmApiKey?: string;
  hindsightLlmModel?: string;
  boatUpdater?: BoatUpdater;
};

type LocalObject = {
  name: string;
  workspace: ReturnType<typeof makeWorkspace>;
};

function makeWorkspace(
  ctor: WorkspaceConstructor | undefined,
  storage: LocalStorage,
  env: LocalEnv,
  factory?: LocalControlOptions["workspaceFactory"],
) {
  const state: DurableObjectState = {
    storage: storage as unknown as DurableObjectStorage,
    waitUntil(promise: Promise<unknown>) {
      storage.waitUntil(promise);
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as DurableObjectState;
  const instance = factory ? factory(state, env) : new ctor!(state, env);
  return { instance, state, storage };
}

function namespace(
  ctor: WorkspaceConstructor | undefined,
  storage: LocalStorage,
  env: LocalEnv,
  factory?: LocalControlOptions["workspaceFactory"],
): DurableObjectNamespace {
  const objects = new Map<string, LocalObject>();
  return {
    idFromName(name: string) {
      return { toString: () => name, name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = String((id as unknown as { name?: string }).name ?? id);
      let value = objects.get(name);
      if (!value) {
        value = { name, workspace: makeWorkspace(ctor, storage, env, factory) };
        objects.set(name, value);
      }
      return {
        fetch: (request: Request) => value!.workspace.instance.fetch(request),
        alarm: () => value!.workspace.instance.alarm?.(),
        assertIdleForUpdate: () => (value!.workspace.instance as any).assertIdleForUpdate(),
        setUpdateMaintenance: (updating: boolean) => (value!.workspace.instance as any).setUpdateMaintenance(updating),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function assetsFetcher(
  root: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405 });
  const rootPath = resolve(root);
  let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!pathname || pathname.endsWith("/")) pathname += "index.html";
  const path = resolve(rootPath, pathname);
  if (relative(rootPath, path).startsWith(".."))
    return new Response("not found", { status: 404 });
  try {
    const info = await stat(path);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    const headers = {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": "no-cache",
    };
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(createReadStream(path) as unknown as BodyInit, {
      headers,
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function tokenFromFile(
  path: string | undefined,
): Promise<string | undefined> {
  if (!path) return undefined;
  const info = await stat(path);
  // Tokens are credentials; reject accidentally world-readable bootstrap files.
  if ((info.mode & 0o077) !== 0)
    throw new Error(`token file must be mode 600: ${path}`);
  const token = (await readFile(path, "utf8")).trim();
  if (!token) throw new Error(`token file is empty: ${path}`);
  return token;
}

function requestFromNode(
  req: IncomingMessage,
  signal: AbortSignal,
): Promise<Request> {
  const protocol =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  if (body)
    signal.addEventListener("abort", () => req.destroy(), { once: true });
  return Promise.resolve(
    new Request(`${protocol}://${host}${req.url ?? "/"}`, {
      method,
      headers,
      body,
      signal,
      duplex: body ? "half" : undefined,
    } as RequestInit),
  );
}

async function sendResponse(
  response: Response,
  res: ServerResponse,
  request: IncomingMessage,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body || request.method === "HEAD") {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel();
  };
  res.once("close", abort);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!res.write(Buffer.from(chunk.value)))
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
    }
    if (!res.destroyed) res.end();
  } catch {
    res.destroy();
  } finally {
    res.off("close", abort);
    reader.releaseLock();
  }
}

export async function createLocalControl(
  options: LocalControlOptions,
): Promise<{
  server: ReturnType<typeof createServer>;
  close(): Promise<void>;
  port(): number;
}> {
  await mkdir(resolve(options.databasePath, ".."), { recursive: true });
  const storage = openLocalStorage(options.databasePath);
  const ctor =
    options.workspace ??
    (options.workspaceFactory
      ? undefined
      : ((await import("../../../apps/control-worker/src/index.ts"))
          .Workspace as unknown as WorkspaceConstructor));
  const appToken =
    options.appToken ??
    (await tokenFromFile(options.appTokenFile)) ??
    (typeof options.env?.APP_TOKEN === "string" ? options.env.APP_TOKEN : undefined);
  if (!appToken) {
    storage.close();
    throw new Error("APP_TOKEN or appTokenFile is required for control-local");
  }
  const runnerToken =
    options.runnerToken ??
    (await tokenFromFile(options.runnerTokenFile)) ??
    (typeof options.env?.RUNNER_TOKEN === "string" ? options.env.RUNNER_TOKEN : undefined) ??
    appToken;
  const hostingProvider = typeof options.env?.HOSTING_PROVIDER === "string" ? options.env.HOSTING_PROVIDER : "local";
  const defaultComputerLabel = typeof options.env?.DEFAULT_COMPUTER_LABEL === "string"
    ? options.env.DEFAULT_COMPUTER_LABEL
    : hostingProvider === "local" ? "Local computer" : undefined;
  const env = {
    ...(options.env ?? {}),
    APP_TOKEN: appToken,
    RUNNER_TOKEN: runnerToken,
    HOSTING_PROVIDER: hostingProvider,
    ...(defaultComputerLabel ? { DEFAULT_COMPUTER_LABEL: defaultComputerLabel } : {}),
    WORKSPACE: null as unknown as DurableObjectNamespace,
  } as LocalEnv;
  if (options.boatUpdater) env.APP_UPDATER = options.boatUpdater;
  env.WORKSPACE = namespace(ctor, storage, env, options.workspaceFactory);
  let objectStore: LocalObjectStore | undefined;
  if (options.objectStorePath) {
    objectStore = new LocalObjectStore(resolve(options.objectStorePath));
    await objectStore.init();
    env.ARTIFACTS = objectStore as unknown as R2Bucket;
  }
  const localProvider =
    options.computerProvider ??
    new LocalComputerProvider({
      dataDir: resolve(
        options.computerDataDir ?? `${options.databasePath}.runtime`,
      ),
      runnerScript: options.runnerScript,
      workspacePath: options.workspacePath,
      checkpointStore: objectStore,
    });
  env.COMPUTER_PROVIDER = localProvider;
  const hindsightToken = options.hindsightToken ?? options.env?.HINDSIGHT_TOKEN;
  const localMemoryConfigured = Boolean(
    (options.hindsightLlmBaseUrl ?? options.env?.HINDSIGHT_LLM_BASE_URL) &&
    (options.hindsightLlmApiKey ?? options.env?.HINDSIGHT_LLM_API_KEY) &&
    (options.hindsightLlmModel ?? options.env?.HINDSIGHT_LLM_MODEL),
  );
  if (hindsightToken && localMemoryConfigured)
    env.HINDSIGHT_FACTORY = (instance: (id: string) => void) =>
      new LocalHindsight({
        token: String(hindsightToken),
        baseUrl:
          options.hindsightBaseUrl ??
          String(options.env?.HINDSIGHT_BASE_URL ?? "http://127.0.0.1:8790"),
        llmBaseUrl:
          options.hindsightLlmBaseUrl ??
          (options.env?.HINDSIGHT_LLM_BASE_URL as string | undefined),
        llmApiKey:
          options.hindsightLlmApiKey ??
          (options.env?.HINDSIGHT_LLM_API_KEY as string | undefined),
        llmModel:
          options.hindsightLlmModel ??
          (options.env?.HINDSIGHT_LLM_MODEL as string | undefined),
        instance,
      });
  if (options.assetsPath)
    env.ASSETS = {
      fetch: (request: Request) => assetsFetcher(options.assetsPath!, request),
    } as unknown as Fetcher;
  const workspace = env.WORKSPACE.get(
    env.WORKSPACE.idFromName("owner"),
  ) as unknown as {
    fetch(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  };
  (options.boatUpdater as any)?.attachWorkspace?.({
    assertIdle: async () => (workspace as any).assertIdleForUpdate?.(),
    setUpdating: (value: boolean) => (workspace as any).setUpdateMaintenance?.(value),
  });
  await options.boatUpdater?.reconcile();
  storage.setAlarmHandler(async () => {
    await options.boatUpdater?.reconcile();
    if (workspace.alarm) await workspace.alarm();
    else
      await workspace.fetch(
        new Request("http://workspace/internal/sweep", { method: "POST" }),
      );
  });
  const worker =
    options.worker ??
    (await import("../../../apps/control-worker/src/index.ts")).default;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      await options.boatUpdater?.reconcile();
      const request = await requestFromNode(req, controller.signal);
      await sendResponse(await worker.fetch(request, env), res, req);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      } else res.destroy();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    server,
    port: () => (server.address() as any)?.port ?? 0,
    close: async () => {
      await new Promise<void>((resolve) => {
        let finished = false;
        const done = () => {
          if (!finished) {
            finished = true;
            resolve();
          }
        };
        server.close(done);
        setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          done();
        }, 5_000).unref();
      });
      const computers = (localProvider as any).computers as
        Map<string, unknown> | undefined;
      if (computers)
        for (const id of computers.keys())
          await localProvider.stop(id, "graceful").catch(() => undefined);
      await storage.drain();
      storage.close();
    },
  };
}

export async function startLocalControl(
  options: LocalControlOptions,
): Promise<Awaited<ReturnType<typeof createLocalControl>>> {
  const control = await createLocalControl(options);
  await new Promise<void>((resolve, reject) =>
    control.server
      .listen(options.port ?? 8789, options.host ?? "127.0.0.1", () =>
        resolve(),
      )
      .once("error", reject),
  );
  return control;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const control = await startLocalControl({
    env: {
      ...(process.env.HOSTING_PROVIDER ? { HOSTING_PROVIDER: process.env.HOSTING_PROVIDER } : {}),
      ...(process.env.DEFAULT_COMPUTER_LABEL ? { DEFAULT_COMPUTER_LABEL: process.env.DEFAULT_COMPUTER_LABEL } : {}),
    },
    host: process.env.APP_HOST ?? "127.0.0.1",
    port: Number(process.env.APP_PORT ?? 8789),
    databasePath: process.env.OPENCODE_STATE ?? "./.local/control.sqlite",
    objectStorePath: process.env.OPENCODE_OBJECTS ?? "./.local/objects",
    computerDataDir: process.env.OPENCODE_COMPUTERS ?? "./.local/computers",
    runnerScript: process.env.OPENCODE_RUNNER_SCRIPT,
    assetsPath: process.env.OPENCODE_ASSETS,
    appToken: process.env.APP_TOKEN,
    appTokenFile: process.env.APP_TOKEN_FILE,
    runnerToken: process.env.RUNNER_TOKEN,
    runnerTokenFile: process.env.RUNNER_TOKEN_FILE,
    hindsightToken: process.env.HINDSIGHT_TOKEN,
    hindsightBaseUrl: process.env.HINDSIGHT_BASE_URL,
    hindsightLlmBaseUrl: process.env.HINDSIGHT_LLM_BASE_URL,
    hindsightLlmApiKey: process.env.HINDSIGHT_LLM_API_KEY,
    hindsightLlmModel: process.env.HINDSIGHT_LLM_MODEL,
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await control.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`control-local listening on ${control.port()}`);
}
