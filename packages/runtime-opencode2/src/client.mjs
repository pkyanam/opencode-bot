import { OpenCode, isSessionNotFoundError } from "@opencode/client";
import * as ServiceModule from "@opencode/client/service";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createPlaywrightMcpServer } from "../../browser/src/index.ts";

const Service = ServiceModule.Service ?? ServiceModule;
const pendingOAuthCallbacks = new Map();

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
    this.botTools = options.botTools;
    this._eventsStarted = false;
    this.catalogCache = new Map();
    this.messageCache = new Map();
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
      config.mcp.servers.computer_browser = { ...createPlaywrightMcpServer({
        command: process.env.PLAYWRIGHT_MCP_BIN ?? '/opt/opencode-bot/runner/node_modules/.bin/playwright-mcp',
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? '/opt/ms-playwright/chromium-1246/chrome-linux64/chrome',
        noSandbox: true,
        headless: !this.desktop,
        ...(this.desktop ? {
          cdpEndpoint: process.env.OPENCODE_BOT_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
          cdpTimeoutMs: 30_000,
        } : {}),
      }), codemode: false };
      if (config.mcp.servers.browser?.command?.some(part => String(part).includes("playwright-mcp"))) delete config.mcp.servers.browser;
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      // Project configuration is location-scoped. Writing it beside the
      // workspace makes MCP discovery deterministic when the daemon's cwd is
      // not the same as the Worker's process cwd.
      const projectConfigPath = `${this.directory}/opencode.json`;
      const projectConfig = await readConfig(projectConfigPath);
      projectConfig.mcp ??= {}; projectConfig.mcp.servers ??= {};
      projectConfig.mcp.servers.computer_browser = config.mcp.servers.computer_browser;
      if (projectConfig.mcp.servers.browser?.command?.some(part => String(part).includes("playwright-mcp"))) delete projectConfig.mcp.servers.browser;
      await writeFile(projectConfigPath, JSON.stringify(projectConfig), { mode: 0o600 });
    }
    if (this.botTools) {
      for (const configPath of [`${this.root}/config/opencode/opencode.json`, `${this.directory}/opencode.json`]) {
        const config = await readConfig(configPath);
        config.mcp ??= {}; config.mcp.servers ??= {};
        config.mcp.servers.bots = { type: 'local', command: this.botTools.command, environment: this.botTools.env, codemode: false, timeout: { startup: 30000, catalog: 30000, execution: 15000 } };
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      }
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
    await Promise.all([...(this.browser && this.client.mcp?.list ? [this.waitForBrowserMcp()] : []), ...(this.botTools && this.client.mcp?.list ? [this.waitForBrowserMcp(30_000, "bots")] : [])]);
    return this.client;
  }

  async waitForBrowserMcp(timeoutMs = 30_000, serverName = "computer_browser") {
    const deadline = Date.now() + timeoutMs;
    let delayMs = 100;
    let last;
    do {
      last = await this.client.mcp.list({ location: { directory: this.directory } });
      const browser = last?.data?.find((server) => server.name === serverName);
      if (browser?.status?.status === "connected") return last;
      if (browser?.status?.status === "error" || browser?.status?.status === "failed") {
        throw new Error(`${serverName} MCP failed to connect: ${JSON.stringify(browser.status)}`);
      }
      // MCP startup is usually a few hundred milliseconds, but can be slow
      // when Chromium is being launched. Back off between readiness reads so
      // a cold start does not create a 4 req/s burst for the full timeout.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    } while (Date.now() < deadline);
    throw new Error(`${serverName} MCP did not become ready within ${timeoutMs}ms: ${JSON.stringify(last)}`);
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

  async removeSession(sessionId) {
    await this.start();
    if (!this.client.session.remove) throw new Error("OpenCode 2 session removal API is unavailable");
    try {
      await this.client.session.remove({ sessionID: sessionId });
    } catch (error) {
      // A control-plane row may outlive the native session after a restore or
      // runtime reset. Treat that idempotent cleanup case as HTTP 404 so the
      // control worker can remove its durable records. Keep every other native
      // failure (including authorization) intact for the caller.
      if (isSessionNotFoundError(error)) {
        throw Object.assign(new Error("native session not found"), { statusCode: 404 });
      }
      throw error;
    }
  }

  async prompt(sessionId, text, options = {}) {
    await this.start();
    const input = {
      sessionID: sessionId,
      text,
      ...(Array.isArray(options.files) && options.files.length ? { files: options.files } : {}),
      ...(options.messageId ? { id: options.messageId } : {}),
      ...(options.resume !== undefined ? { resume: options.resume } : {}),
      ...(options.delivery ? { delivery: options.delivery } : {})
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
    const cached = this.catalogCache.get(directory);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const entry = {expiresAt:Infinity,promise:undefined};
    entry.promise = this.readCatalog(directory).then(value => {
      entry.expiresAt = Date.now() + (value.models.length ? 5000 : 500);
      return value;
    }, error => { if (this.catalogCache.get(directory) === entry) this.catalogCache.delete(directory); throw error; });
    this.catalogCache.set(directory,entry);
    return entry.promise;
  }

  async readCatalog(directory = this.directory) {
    await this.start();
    const location = { location: { directory } };
    // OpenCode hydrates provider/model/agent registries asynchronously after
    // the daemon starts. A single read often returns empty data even though
    // the same location is ready a few hundred milliseconds later.
    let models = { data: [] }, providers = { data: [] }, agents = { data: [] };
    let commands = { data: [] }, mcp = { data: [] };
    const deadline = Date.now() + 8_000;
    do {
      // Models are the registry that signals that location hydration has
      // completed. Retrying every registry while waiting causes repeated
      // provider/MCP/command work during daemon startup; poll only the
      // readiness endpoint, then read the remaining registries once.
      models = await this.client.model.list(location);
      if ((models?.data?.length ?? 0) > 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    [providers, agents, commands, mcp] = await Promise.all([
      this.client.provider.list(location),
      this.client.agent.list(location),
      this.client.command.list(location),
      this.client.mcp.list(location),
    ]);
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

  /** Manage location-scoped MCP servers through OpenCode's native API. */
  async mcpList(directory = this.directory) {
    await this.start();
    if (!this.client.mcp?.list) throw new Error("OpenCode MCP API is unavailable");
    const location = nativeLocation(directory);
    const [result, integrations] = await Promise.all([
      this.client.mcp.list(location),
      this.client.integration?.list ? this.client.integration.list(location) : { data: [] },
    ]);
    return {
      location: directory,
      servers: (result?.data ?? []).map(({ name, status, integrationID }) => ({ name, status, ...(integrationID ? { integrationID } : {}) })),
      integrations: (integrations?.data ?? []).map(sanitizeIntegration),
    };
  }

  async mcpAdd({ server, config, directory } = {}) {
    requireNonEmpty(server, "server");
    if (!config || typeof config !== "object") throw new Error("config is required");
    await this.start();
    if (!this.client.mcp?.add) throw new Error("OpenCode MCP API is unavailable");
    await this.client.mcp.add({ server, config, ...nativeLocation(directory ?? this.directory) });
    return { ok: true, server };
  }

  async mcpRemove({ server, directory } = {}) {
    requireNonEmpty(server, "server");
    await this.start();
    if (!this.client.mcp?.remove) throw new Error("OpenCode MCP API is unavailable");
    await this.client.mcp.remove({ server, ...nativeLocation(directory ?? this.directory) });
    return { ok: true, server };
  }

  async mcpConnect({ server, directory } = {}) {
    requireNonEmpty(server, "server");
    await this.start();
    if (!this.client.mcp?.connect) throw new Error("OpenCode MCP API is unavailable");
    await this.client.mcp.connect({ server, ...nativeLocation(directory ?? this.directory) });
    return { ok: true, server };
  }

  async mcpDisconnect({ server, directory } = {}) {
    requireNonEmpty(server, "server");
    await this.start();
    if (!this.client.mcp?.disconnect) throw new Error("OpenCode MCP API is unavailable");
    await this.client.mcp.disconnect({ server, ...nativeLocation(directory ?? this.directory) });
    return { ok: true, server };
  }

  async mcpResources(directory = this.directory) {
    await this.start();
    if (!this.client.mcp?.resource?.catalog) throw new Error("OpenCode MCP resource API is unavailable");
    const result = await this.client.mcp.resource.catalog(nativeLocation(directory));
    return { location: directory, ...(result?.data ?? { resources: [], templates: [] }) };
  }

  /**
   * Return the native provider and integration registry for a location.
   *
   * OpenCode owns credential storage.  This method deliberately projects the
   * response to connection metadata and auth form descriptions; provider
   * settings, headers, and credentials are never returned to the caller.
   */
  async providers(directory = this.directory) {
    await this.start();
    const location = nativeLocation(directory);
    const [providers, integrations] = await Promise.all([
      this.client.provider.list(location),
      this.client.integration?.list ? this.client.integration.list(location) : { data: [] },
    ]);
    return {
      location: directory,
      providers: (providers?.data ?? []).map(sanitizeProvider),
      integrations: (integrations?.data ?? []).map(sanitizeIntegration),
    };
  }

  /** Return one provider and its native integration/auth schema. */
  async providerStatus(providerID, directory = this.directory) {
    if (!providerID) throw new Error("providerID is required");
    await this.start();
    const location = nativeLocation(directory);
    const provider = await this.client.provider.get({ providerID, ...location });
    let integration;
    const integrationID = provider?.data?.integrationID ?? provider?.data?.id;
    if (integrationID && this.client.integration?.get) {
      try {
        integration = await this.client.integration.get({ integrationID, ...location });
      } catch (error) {
        // A provider does not necessarily have a first-party integration.
        // Preserve the provider status while leaving the auth schema absent.
        if (!isNotFound(error)) throw error;
      }
    }
    return {
      location: directory,
      provider: sanitizeProvider(provider?.data),
      ...(integration?.data ? { integration: sanitizeIntegration(integration.data) } : {}),
    };
  }

  /**
   * Connect a native key integration. The key is passed directly to the
   * daemon and is intentionally absent from both the return value and errors.
   */
  async configureProvider({ integrationID, key, answer, label, directory } = {}) {
    this.catalogCache.clear();
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(key, "key");
    await this.start();
    if (!this.client.integration?.connect?.key) throw new Error("OpenCode provider key connection API is unavailable");
    try {
      await this.client.integration.connect.key({
        integrationID,
        ...nativeLocation(directory ?? this.directory),
        key,
        ...(answer === undefined ? {} : { answer }),
        ...(label === undefined ? {} : { label }),
      });
    } catch {
      // Do not propagate upstream error payloads: some providers include the
      // submitted credential in validation errors.
      throw new Error("OpenCode provider key connection failed");
    }
    return { ok: true, integrationID };
  }

  /**
   * Add or update a v2 custom provider in the runtime-owned opencode.json.
   * ConfigV2's HTTP update endpoint only edits `shell`; provider definitions
   * are therefore written through the authored `providers.<id>` config shape
   * (`package`, `settings`, and `models`). The file is private to this
   * runtime and written atomically with mode 0600.
   */
  async configureCustomProvider({ providerID, name, baseURL, modelIDs, models, apiKey, packageName = "@opencode/ai/providers/openai-compatible", settings, headers, body, restart = true } = {}) {
    this.catalogCache.clear();
    requireProviderID(providerID);
    requireNonEmpty(baseURL, "baseURL");
    const modelNames = normalizeModelIDs(modelIDs, models);
    if (modelNames.length === 0) throw new Error("at least one modelID is required");
    try { new URL(baseURL); } catch { throw new Error("baseURL must be a valid URL"); }
    requireNonEmpty(packageName, "packageName");
    const configPath = `${this.root}/config/opencode/opencode.json`;
    await mkdir(`${this.root}/config/opencode`, { recursive: true });
    const config = await readConfig(configPath);
    const priorConfig = JSON.parse(JSON.stringify(config));
    config.providers ??= {};
    const previous = config.providers[providerID] && typeof config.providers[providerID] === "object" ? config.providers[providerID] : {};
    const previousSettings = previous.settings && typeof previous.settings === "object" ? previous.settings : {};
    const nextSettings = { ...previousSettings, ...(settings ?? {}) };
    if (apiKey === null) delete nextSettings.apiKey;
    else if (apiKey !== undefined) {
      requireNonEmpty(apiKey, "apiKey");
      nextSettings.apiKey = apiKey;
    }
    const nextModels = models && typeof models === "object" && !Array.isArray(models)
      ? { ...models }
      : Object.fromEntries(modelNames.map((id) => [id, { name: id }]));
    const nextProvider = {
      ...previous,
      ...(name === undefined ? {} : { name: String(name) }),
      package: packageName,
      settings: { ...nextSettings, baseURL, ...(headers ? { headers } : {}), ...(body ? { body } : {}) },
      models: nextModels,
    };
    // `providers` is the authored v2 config shape. The daemon normalizes it
    // to ProviderV2.Info internally; do not write the normalized `api` shape
    // back to disk because it loses the configured SDK package on reload.
    delete nextProvider.api;
    config.providers[providerID] = nextProvider;
    await writePrivateConfig(configPath, config);
    const reload = Boolean(restart && this.endpoint);
    if (reload) {
      let previousError;
      await this.stop();
      try {
        // A fresh daemon is required: the v2 config catalog is bootstrapped
        // at location startup and has no provider-config reload endpoint.
        await this.start();
      } catch (error) {
        previousError = error;
        await writePrivateConfig(configPath, priorConfig);
        try { await this.stop(); } catch {}
        try { await this.start(); } catch {}
      }
      if (previousError) throw new Error("custom provider configuration could not be loaded");
    }
    return { ok: true, providerID, modelIDs: modelNames, reloaded: reload };
  }

  /** Return a safe view of one runtime-owned custom provider config. */
  async customProviderStatus(providerID) {
    requireProviderID(providerID);
    const config = await readConfig(`${this.root}/config/opencode/opencode.json`);
    const provider = config.providers?.[providerID];
    if (!provider || typeof provider !== "object") return { configured: false, providerID };
    const api = provider.api && typeof provider.api === "object" ? provider.api : {};
    const packageName = provider.package ?? api.package;
    const settings = provider.settings && typeof provider.settings === "object" ? provider.settings : (api.settings ?? {});
    const modelMap = provider.models && typeof provider.models === "object" ? provider.models : {};
    return {
      configured: true,
      providerID,
      ...(provider.name ? { name: provider.name } : {}),
      packageName,
      ...(settings.baseURL || api.url ? { baseURL: redactUrl(settings.baseURL ?? api.url) } : {}),
      modelIDs: Object.keys(modelMap),
      hasApiKey: typeof settings.apiKey === "string" && settings.apiKey.length > 0,
    };
  }

  /** Native credential lifecycle operations, with no credential material returned. */
  async updateProviderCredential({ credentialID, label } = {}) {
    this.catalogCache.clear();
    requireNonEmpty(credentialID, "credentialID");
    requireNonEmpty(label, "label");
    await this.start();
    if (!this.client.credential?.update) throw new Error("OpenCode credential update API is unavailable");
    await this.client.credential.update({ credentialID, label });
    return { ok: true, credentialID };
  }

  async activateProviderCredential({ credentialID } = {}) {
    this.catalogCache.clear();
    requireNonEmpty(credentialID, "credentialID");
    await this.start();
    if (!this.client.credential?.activate) throw new Error("OpenCode credential activation API is unavailable");
    await this.client.credential.activate({ credentialID });
    return { ok: true, credentialID };
  }

  async removeProviderCredential({ credentialID } = {}) {
    this.catalogCache.clear();
    requireNonEmpty(credentialID, "credentialID");
    await this.start();
    if (!this.client.credential?.remove) throw new Error("OpenCode credential removal API is unavailable");
    await this.client.credential.remove({ credentialID });
    return { ok: true, credentialID };
  }

  async providerOAuthStart({ integrationID, methodID, answer, label, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(methodID, "methodID");
    await this.start();
    if (!this.client.integration?.oauth?.connect) throw new Error("OpenCode provider OAuth API is unavailable");
    let result;
    try {
      result = await this.client.integration.oauth.connect({
        integrationID,
        ...nativeLocation(directory ?? this.directory),
        methodID,
        ...(answer === undefined ? {} : { answer }),
        ...(label === undefined ? {} : { label }),
      });
    } catch {
      throw new Error("OpenCode provider OAuth connection failed");
    }
    rememberOAuthCallback(integrationID, result);
    return sanitizeAttemptResult(result);
  }

  async providerOAuthStatus({ integrationID, attemptID, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(attemptID, "attemptID");
    await this.start();
    if (!this.client.integration?.oauth?.status) throw new Error("OpenCode provider OAuth API is unavailable");
    return sanitizeStatusResult(await this.client.integration.oauth.status({ integrationID, attemptID, ...nativeLocation(directory ?? this.directory) }));
  }

  async providerOAuthComplete({ integrationID, attemptID, code, callbackUrl, directory } = {}) {
    this.catalogCache.clear();
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(attemptID, "attemptID");
    if (code !== undefined && callbackUrl !== undefined) throw new Error("Provide code or callbackUrl, not both");
    const pending = pendingOAuthCallbacks.get(`${integrationID}:${attemptID}`);
    if (pending && pending.expiresAt <= Date.now()) { pendingOAuthCallbacks.delete(`${integrationID}:${attemptID}`); throw new Error("OAuth callback attempt expired; start sign-in again"); }
    if (callbackUrl !== undefined && !pending) throw new Error("This callback has no matching pending login. Start sign-in again, or use Sign in on Computer.");
    let completionCode = callbackUrl === undefined ? code : parseLocalOAuthCallback(callbackUrl);
    if (callbackUrl !== undefined && pending?.mode === "auto") {
      if (pending.expiresAt <= Date.now()) { pendingOAuthCallbacks.delete(`${integrationID}:${attemptID}`); throw new Error("OAuth callback attempt expired; start sign-in again"); }
      await deliverOAuthCallback(pending, callbackUrl);
      completionCode = undefined;
    }
    await this.start();
    if (!this.client.integration?.oauth?.complete) throw new Error("OpenCode provider OAuth API is unavailable");
    try {
      await this.client.integration.oauth.complete({ integrationID, attemptID, ...nativeLocation(directory ?? this.directory), ...(completionCode === undefined ? {} : { code: completionCode }) });
    } catch {
      throw new Error("OpenCode provider OAuth completion failed");
    }
    pendingOAuthCallbacks.delete(`${integrationID}:${attemptID}`);
    return { ok: true, integrationID, attemptID };
  }

  async providerOAuthCancel({ integrationID, attemptID, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(attemptID, "attemptID");
    await this.start();
    if (!this.client.integration?.oauth?.cancel) throw new Error("OpenCode provider OAuth API is unavailable");
    await this.client.integration.oauth.cancel({ integrationID, attemptID, ...nativeLocation(directory ?? this.directory) });
    pendingOAuthCallbacks.delete(`${integrationID}:${attemptID}`);
    return { ok: true, integrationID, attemptID };
  }

  async providerCommandStart({ integrationID, methodID, label, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(methodID, "methodID");
    await this.start();
    if (!this.client.integration?.command?.connect) throw new Error("OpenCode provider command connection API is unavailable");
    return sanitizeAttemptResult(await this.client.integration.command.connect({ integrationID, methodID, ...nativeLocation(directory ?? this.directory), ...(label === undefined ? {} : { label }) }));
  }

  async providerCommandStatus({ integrationID, attemptID, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(attemptID, "attemptID");
    await this.start();
    if (!this.client.integration?.command?.status) throw new Error("OpenCode provider command connection API is unavailable");
    return sanitizeStatusResult(await this.client.integration.command.status({ integrationID, attemptID, ...nativeLocation(directory ?? this.directory) }));
  }

  async providerCommandCancel({ integrationID, attemptID, directory } = {}) {
    requireNonEmpty(integrationID, "integrationID");
    requireNonEmpty(attemptID, "attemptID");
    await this.start();
    if (!this.client.integration?.command?.cancel) throw new Error("OpenCode provider command connection API is unavailable");
    await this.client.integration.command.cancel({ integrationID, attemptID, ...nativeLocation(directory ?? this.directory) });
    return { ok: true, integrationID, attemptID };
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
  async messages(sessionID, { cache = false } = {}) {
    await this.start();
    if (!cache) return (await this.client.message.list({sessionID})).data;
    const prior = this.messageCache.get(sessionID);
    if (prior && prior.expiresAt > Date.now()) return prior.promise;
    const entry = {expiresAt:Infinity,promise:undefined};
    entry.promise = this.client.message.list({sessionID}).then(result => {
      entry.expiresAt = Date.now() + 1000;
      return result.data;
    }, error => {this.messageCache.delete(sessionID); throw error;});
    this.messageCache.set(sessionID,entry);
    if (this.messageCache.size > 100) this.messageCache.delete(this.messageCache.keys().next().value);
    return entry.promise;
  }
  async permissions(sessionID, signal) {
    await this.start();
    return this.client.permission.list({ sessionID }, signal ? { signal } : undefined);
  }

  async *log(sessionId, after = 0, follow = false) {
    await this.start();
    yield* this.client.session.log({ sessionID: sessionId, after, follow });
  }

  async stop() {
    this.catalogCache.clear();
    this.messageCache.clear();
    if (this.endpoint) await this.service.stop({ file: this.serviceFile });
    if (this.desktop?.close) await this.desktop.close();
    this.client = undefined;
    this.endpoint = undefined;
  }
}

function parseLocalOAuthCallback(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("callbackUrl must be a bounded URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("callbackUrl must be a valid URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.pathname !== '/callback') throw new Error("callbackUrl must be the local OAuth callback URL");
  if (url.searchParams.get('error')) throw new Error(`OAuth callback returned ${url.searchParams.get('error')}`);
  if (url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('state').length > 1) throw new Error("OAuth callback URL contains duplicate code or state");
  const callbackCode = url.searchParams.get('code');
  if (!callbackCode) throw new Error("OAuth callback URL is missing code");
  if (!url.searchParams.get('state')) throw new Error("OAuth callback URL is missing state");
  return callbackCode;
}

function rememberOAuthCallback(integrationID, result) {
  const attempt = result?.data ?? result;
  const attemptID = attempt?.attemptID;
  if (typeof attemptID !== "string") return;
  let authorization;
  try { authorization = new URL(attempt.url); } catch { return; }
  const redirect = authorization.searchParams.get("redirect_uri");
  const state = authorization.searchParams.get("state");
  if (attempt.mode === "code") { pendingOAuthCallbacks.set(`${integrationID}:${attemptID}`, { mode: "code", expiresAt: Date.now() + 15 * 60_000 }); if (pendingOAuthCallbacks.size > 32) pendingOAuthCallbacks.delete(pendingOAuthCallbacks.keys().next().value); return; }
  if (!redirect || !state || attempt.mode !== "auto") return;
  let redirectUrl;
  try { redirectUrl = validateLoopbackUrl(redirect); } catch { return; }
  pendingOAuthCallbacks.set(`${integrationID}:${attemptID}`, { redirectUrl, state, mode: "auto", expiresAt: Date.now() + 15 * 60_000 });
  if (pendingOAuthCallbacks.size > 32) pendingOAuthCallbacks.delete(pendingOAuthCallbacks.keys().next().value);
}

function validateLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) || url.username || url.password || url.hash || !url.port || Number(url.port) < 1 || Number(url.port) > 65535 || url.pathname !== "/callback") throw new Error("OAuth callback must be the exact local loopback callback");
  return url;
}

async function deliverOAuthCallback(pending, value) {
  const callback = validateLoopbackUrl(value);
  const expected = pending.redirectUrl;
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.searchParams.get("state") !== pending.state) throw new Error("OAuth callback does not match the pending authorization state or redirect");
  if (callback.searchParams.getAll("code").length !== 1 || callback.searchParams.getAll("state").length !== 1) throw new Error("OAuth callback URL contains duplicate code or state");
  if (callback.searchParams.get("error")) throw new Error(`OAuth callback returned ${callback.searchParams.get("error")}`);
  if (!callback.searchParams.get("code")) throw new Error("OAuth callback URL is missing code");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(callback, { redirect: "manual", signal: controller.signal });
    if (response.status >= 400) throw new Error(`OAuth callback listener returned HTTP ${response.status}`);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("OAuth callback listener timed out");
    throw error;
  } finally { clearTimeout(timer); }
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

function nativeLocation(directory) {
  return { location: { directory } };
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
}

function requireProviderID(value) {
  requireNonEmpty(value, "providerID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("providerID contains unsupported characters");
}

function normalizeModelIDs(modelIDs, models) {
  const fromMap = models && typeof models === "object" && !Array.isArray(models) ? Object.keys(models) : [];
  const input = Array.isArray(modelIDs) ? modelIDs : fromMap;
  return [...new Set(input.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}

async function writePrivateConfig(filename, config) {
  const temporary = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) if (isSecretKey(key) || /^(key|auth|sig)$/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function isNotFound(error) {
  return error?.status === 404 || error?.statusCode === 404 || error?.response?.status === 404 || /not found/i.test(String(error?.message ?? ""));
}

// Provider and integration responses are upstream objects. Keep an explicit
// allowlist for credential-bearing records instead of trying to redact an
// arbitrary object after it has reached an HTTP response or log statement.
function sanitizeProvider(value) {
  if (!value || typeof value !== "object") return value;
  return pick(value, ["id", "canonical", "integrationID", "name", "activation", "package"]);
}

function sanitizeIntegration(value) {
  if (!value || typeof value !== "object") return value;
  return {
    id: value.id,
    name: value.name,
    methods: Array.isArray(value.methods) ? value.methods.map(sanitizeMethod) : [],
    connections: Array.isArray(value.connections) ? value.connections.map(sanitizeConnection) : [],
  };
}

function sanitizeMethod(value) {
  if (!value || typeof value !== "object") return value;
  const out = pick(value, ["id", "type", "label", "command"]);
  // Forms describe the native API's fields and choices. Redact any default
  // values or metadata that an upstream integration may mark as sensitive.
  if (value.form && typeof value.form === "object") out.form = sanitizeObject(value.form);
  return out;
}

function sanitizeConnection(value) {
  if (!value || typeof value !== "object") return value;
  return pick(value, ["type", "id", "label", "name"]);
}

function sanitizeAttemptResult(value) {
  const data = value?.data ?? value;
  if (!data || typeof data !== "object") return {};
  return {
    ...(value?.location ? { location: value.location } : {}),
    attempt: pick(data, ["attemptID", "url", "instructions", "mode", "time"]),
  };
}

function sanitizeStatusResult(value) {
  const data = value?.data ?? value;
  if (!data || typeof data !== "object") return {};
  return {
    ...(value?.location ? { location: value.location } : {}),
    status: pick(data, ["status", "message", "time"]),
  };
}

function pick(value, keys) {
  const out = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!value || typeof value !== "object") return value;
  const secretField = typeof value.key === "string" && isSecretKey(value.key);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (secretField && (key === "default" || key === "value")) continue;
    if (isSecretKey(key) && !(key === "secret" && typeof child === "boolean")) continue;
    out[key] = sanitizeObject(child);
  }
  return out;
}

function isSecretKey(key) {
  return /(^|_|-)(api[-_]?key|secret|token|password|credential|authorization|private[-_]?key|access[-_]?key)(\b|_|-)/i.test(key)
    || /^(apiKey|accessToken|refreshToken|clientSecret|authorization)$/i.test(key);
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
