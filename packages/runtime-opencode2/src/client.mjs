import { OpenCode } from "@opencode/client";
import * as ServiceModule from "@opencode/client/service";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPlaywrightMcpServer } from "../../browser/src/index.ts";

const Service = ServiceModule.Service ?? ServiceModule;

/**
 * Owns one OpenCode 2 daemon and exposes only the operations the application
 * needs. The client is deliberately injected in tests; no global OpenCode
 * credentials or operator home directory are read by this module.
 */
export class OpenCode2Runtime {
  constructor(options = {}) {
    this.root = options.root ?? "/workspace/state";
    this.directory = options.directory ?? "/workspace/shared";
    this.serviceFile = options.serviceFile ?? `${this.root}/state/opencode/service.json`;
    this.version = options.version ?? "2.0.11";
    this.command = options.command ?? ["opencode", "serve", "--service"];
    this.env = { ...options.env };
    this.service = options.service ?? Service;
    this.openCodeFactory = options.openCodeFactory ?? OpenCode.make;
    this.client = options.client;
    this.endpoint = options.endpoint;
    // Optional headed desktop broker. It is deliberately injected so the
    // runtime remains usable in headless tests and non-Cloudflare computers.
    this.desktop = options.desktop;
    this._eventsStarted = false;
    this.browser = options.browser ?? process.env.OPENCODE_BOT_BROWSER === "1";
  }

  async start() {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }

  async _start() {
    if (this.client) return this.client;
    if (this.desktop) {
      await this.desktop.start();
      process.env.DISPLAY = this.desktop.display ?? process.env.DISPLAY ?? ":99";
    }
    await mkdir(this.directory, { recursive: true });
    await mkdir(`${this.root}/config/opencode`, { recursive: true });
    if (this.browser) {
      const configPath = `${this.root}/config/opencode/opencode.json`;
      let config = await readConfig(configPath);
      config.mcp ??= {}; config.mcp.servers ??= {};
      config.mcp.servers.browser = createPlaywrightMcpServer({
        command: process.env.PLAYWRIGHT_MCP_BIN ?? '/opt/opencode-bot/runner/node_modules/.bin/playwright-mcp',
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? '/opt/ms-playwright/chromium-1246/chrome-linux64/chrome',
        noSandbox: true,
        headless: !this.desktop,
        ...(this.desktop ? {
          cdpEndpoint: process.env.OPENCODE_BOT_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
          cdpTimeoutMs: 30_000,
        } : {}),
      });
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      // Project configuration is location-scoped. Writing it beside the
      // workspace makes MCP discovery deterministic when the daemon's cwd is
      // not the same as the Worker's process cwd.
      const projectConfigPath = `${this.directory}/opencode.json`;
      const projectConfig = await readConfig(projectConfigPath);
      projectConfig.mcp ??= {}; projectConfig.mcp.servers ??= {};
      projectConfig.mcp.servers.browser = config.mcp.servers.browser;
      await writeFile(projectConfigPath, JSON.stringify(projectConfig), { mode: 0o600 });
    }
    this.endpoint = await this.service.ensure({
      file: this.serviceFile,
      version: this.version,
      command: this.command,
      env: {
        ...this.env,
        HOME: this.root,
        XDG_STATE_HOME: `${this.root}/state`,
        XDG_DATA_HOME: `${this.root}/data`,
        XDG_CONFIG_HOME: `${this.root}/config`,
        OPENCODE_DIRECTORY: this.directory
        ,...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {})
      }
    });
    const headers = this.service.headers(this.endpoint) ?? {};
    this.client = this.openCodeFactory({
      baseUrl: this.endpoint.url,
      headers,
      throwOnError: true
    });
    await this.client.server.info();
    if (this.browser && this.client.mcp?.list) await this.waitForBrowserMcp();
    return this.client;
  }

  async waitForBrowserMcp(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    do {
      last = await this.client.mcp.list({ location: { directory: this.directory } });
      const browser = last?.data?.find((server) => server.name === "browser");
      if (browser?.status?.status === "connected") return last;
      if (browser?.status?.status === "error" || browser?.status?.status === "failed") {
        throw new Error(`browser MCP failed to connect: ${JSON.stringify(browser.status)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(`browser MCP did not become ready within ${timeoutMs}ms: ${JSON.stringify(last)}`);
  }

  async createSession({ sessionId, title, model, agent, directory } = {}) {
    await this.start();
    if (sessionId) {
      await this.client.session.get({ sessionID: sessionId });
      if (model && this.client.session.switchModel) await this.client.session.switchModel({ sessionID: sessionId, model: normalizeModel(model) });
      if (agent && this.client.session.switchAgent) await this.client.session.switchAgent({ sessionID: sessionId, agent });
      return sessionId;
    }
    const input = {
      ...(sessionId ? { id: sessionId } : {}),
      ...(title ? { title } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model: normalizeModel(model) } : {}),
      location: { directory: directory ?? this.directory }
    };
    const session = await this.client.session.create(input);
    return session.id;
  }

  async prompt(sessionId, text, options = {}) {
    await this.start();
    const input = {
      sessionID: sessionId,
      ...(options.messageId || options.resume !== undefined || options.delivery
        ? { id: { ...(options.messageId ? { id: options.messageId } : {}), text, ...(options.resume !== undefined ? { resume: options.resume } : {}), ...(options.delivery ? { delivery: options.delivery } : {}) } }
        : { text })
    };
    return this.client.session.prompt(input);
  }

  async instructions(sessionID, text) {
    await this.start();
    await this.client.session.instructions.entry.put({sessionID,key:'opencode-bot',value:String(text??'')});
  }

  async command(sessionId, name, text = "") {
    await this.start();
    if (!this.client.session.command) throw new Error("OpenCode 2 session command API is unavailable");
    return this.client.session.command({ sessionID: sessionId, name, text });
  }

  /** Return the live, location-scoped native catalog. Values are upstream data. */
  async catalog(directory = this.directory) {
    await this.start();
    const location = { location: { directory } };
    // OpenCode hydrates provider/model/agent registries asynchronously after
    // the daemon starts. A single read often returns empty data even though
    // the same location is ready a few hundred milliseconds later.
    let models = { data: [] }, providers = { data: [] }, agents = { data: [] };
    let commands = { data: [] }, mcp = { data: [] };
    const deadline = Date.now() + 8_000;
    do {
      [models, providers, agents, commands, mcp] = await Promise.all([
        this.client.model.list(location),
        this.client.provider.list(location),
        this.client.agent.list(location),
        this.client.command.list(location),
        this.client.mcp.list(location),
      ]);
      if ((models?.data?.length ?? 0) > 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return {
      runtime: { name: "opencode2", version: this.version, experimentalApi: true },
      location: directory,
      // Never send provider request settings or authentication headers to the
      // web client. It needs selection metadata, not inference credentials.
      models: (models?.data ?? []).map(({id,modelID,providerID,name,capabilities,variants,cost,status,enabled,limit}) => ({id,modelID,providerID,name,capabilities,variants:(variants??[]).map(({id,name})=>({id,name})),cost,status,enabled,limit})),
      providers: (providers?.data ?? []).map(({id,name}) => ({id,name})),
      agents: (agents?.data ?? []).filter(agent => !agent.hidden).map(({id,name,description,mode,model}) => ({id,name,description,mode,model})),
      commands: (commands?.data ?? []).map((command) => ({ ...command, execution: "native-session-command" })),
      // These are CLI subcommands, not session/TUI commands. They are exposed
      // separately so a client does not present them as runnable session work.
      cliOnlyCommands: ["help", "version", "doctor", "auth", "serve", "service", "mcp", "plugin", "models", "session", "api"],
      // These are application actions backed by explicit v2 APIs. They are
      // intentionally separate from session.command templates and CLI
      // subcommands. Undo needs a messageID from the caller's selected turn.
      actions: [
        { name: "compact", execution: "native-action", action: "compact" },
        { name: "undo", execution: "native-action", action: "revert-stage", requires: ["messageID"] },
        { name: "redo", execution: "native-action", action: "revert-clear", requires: ["stagedRevert"] },
      ],
      mcp: mcp?.data ?? [],
    };
  }

  async compact(sessionID, options = {}) {
    await this.start();
    if (!this.client.session.compact) throw new Error("OpenCode 2 session compact API is unavailable");
    return this.client.session.compact({ sessionID, ...(options.id ? { id: options.id } : {}), ...(options.delivery ? { delivery: options.delivery } : {}) });
  }

  async revertStage(sessionID, messageID, files) {
    await this.start();
    if (!messageID) throw new Error("messageID is required to undo a session turn");
    if (!this.client.session.revert?.stage) throw new Error("OpenCode 2 session revert API is unavailable");
    return this.client.session.revert.stage({ sessionID, messageID, ...(files === undefined ? {} : { files }) });
  }

  async revertClear(sessionID) {
    await this.start();
    if (!this.client.session.revert?.clear) throw new Error("OpenCode 2 session revert API is unavailable");
    return this.client.session.revert.clear({ sessionID });
  }

  async revertCommit(sessionID) {
    await this.start();
    if (!this.client.session.revert?.commit) throw new Error("OpenCode 2 session revert API is unavailable");
    return this.client.session.revert.commit({ sessionID });
  }

  async nativeAction(sessionID, action, payload = {}) {
    switch (action) {
      case "compact": return this.compact(sessionID, payload);
      case "undo":
      case "revert-stage": return this.revertStage(sessionID, payload.messageID, payload.files);
      // OpenCode's snapshot UI calls the operation that cancels a staged
      // rollback "redo"; commit is reserved for applying a staged rollback
      // before the next prompt and is intentionally exposed separately.
      case "redo":
      case "revert-clear": return this.revertClear(sessionID);
      case "revert-commit": return this.revertCommit(sessionID);
      case "revert-clear": return this.revertClear(sessionID);
      case "interrupt": return this.interrupt(sessionID);
      case "wait": return this.wait(sessionID, payload.signal);
      case "model":
        await this.start();
        if (!this.client.session.switchModel) throw new Error("OpenCode 2 model switching API is unavailable");
        return this.client.session.switchModel({ sessionID, model: normalizeModel(payload.model) });
      case "agent":
        await this.start();
        if (!this.client.session.switchAgent) throw new Error("OpenCode 2 agent switching API is unavailable");
        return this.client.session.switchAgent({ sessionID, agent: payload.agent });
      default: throw new Error(`unsupported native action: ${action}`);
    }
  }

  async interrupt(sessionId) {
    await this.start();
    return this.client.session.interrupt({ sessionID: sessionId, resume: false });
  }

  async replyApproval(sessionId, requestId, decision, message) {
    await this.start();
    return this.client.permission.reply({ sessionID: sessionId, requestID: requestId, decision, ...(message ? { message } : {}) });
  }

  async *events(signal) {
    await this.start();
    for await (const event of this.client.event.subscribe({ signal })) yield event;
  }

  async wait(sessionID, signal) { await this.start(); return this.client.session.wait({ sessionID }, { signal }); }
  async messages(sessionID) { await this.start(); return (await this.client.message.list({ sessionID })).data; }
  async permissions(sessionID) { await this.start(); return this.client.permission.list({ sessionID }); }

  async *log(sessionId, after = 0, follow = false) {
    await this.start();
    yield* this.client.session.log({ sessionID: sessionId, after, follow });
  }

  async stop() {
    if (this.endpoint) await this.service.stop({ file: this.serviceFile });
    if (this.desktop?.close) await this.desktop.close();
    this.client = undefined;
    this.endpoint = undefined;
  }
}

async function readConfig(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

function normalizeModel(value) {
  if (typeof value === "object") return value;
  const [reference,variant] = String(value).split('#');
  const [providerID, ...rest] = reference.split("/");
  return { providerID, id: rest.join("/") || providerID, ...(variant?{variant}:{}) };
}

export function eventText(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type && event.type !== 'session.text.delta') return '';
  const properties = event.properties ?? event.data ?? {};
  return properties.text ?? properties.delta ?? properties.content ?? "";
}

export function eventType(event) {
  return event?.type ?? "runtime.event";
}
