import { spawn } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

const BOUNDARY = "opencode-bot-frame";
const DEFAULT_BROWSER_PROFILE = "/workspace/browser/profile";
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const CONTROL_LEASE_MS = 60_000;
const MAX_CONTROL_TEXT = 16_000;
const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
const NAVIGATION_KEYS = new Set(["Backspace", "Delete", "Enter", "Escape", "Tab", "Space", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp"]);
const ALLOWED_SHORTCUTS = new Set([
  ..."ACFLNPRSTUVXYZ".split("").flatMap(key => [`Control+${key}`, `Control+Shift+${key}`]),
  ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].flatMap(key => [`Shift+${key}`, `Control+${key}`, `Control+Shift+${key}`]),
  "Control+Tab", "Control+Shift+Tab",
  "Meta+A", "Meta+C", "Meta+L", "Meta+V", "Meta+X",
  "Alt+ArrowLeft", "Alt+ArrowRight", "Shift+Tab",
]);
const X11_KEYS = new Map([
  ["Backspace", "BackSpace"], ["Enter", "Return"], ["Escape", "Escape"], ["Tab", "Tab"], ["Space", "space"],
  ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"], ["ArrowUp", "Up"], ["PageDown", "Next"], ["PageUp", "Prior"],
  ["Control", "ctrl"], ["Meta", "super"], ["Shift", "shift"], ["Alt", "alt"],
]);
const WELCOME_HTML = `<!doctype html><meta charset="utf-8"><title>OpenCode Bot Desktop</title><style>html,body{margin:0;width:100%;height:100%;background:#111827;color:#e5e7eb;font:16px system-ui,sans-serif}main{display:grid;place-content:center;height:100%;text-align:center}h1{font-size:32px;margin:0 0 12px}p{color:#9ca3af}</style><main><h1>OpenCode Bot</h1><p>Shared headed browser is ready.</p></main>`;

/**
 * Owns the shared headed desktop display and an authenticated-server-facing
 * MJPEG stream. Authentication is deliberately handled by server.mjs before
 * this module is called; this class never accepts a token from a URL.
 *
 * The display remains available for headed browser/MCP processes, but the
 * screenshot loop runs only while at least one viewer is subscribed.
 */
export class DesktopController {
  constructor(options = {}) {
    this.display = options.display ?? process.env.DISPLAY ?? ":99";
    this.width = options.width ?? 1440;
    this.height = options.height ?? 900;
    this.fps = Math.min(5, Math.max(1, options.fps ?? 2));
    this.maxViewers = options.maxViewers ?? 4;
    this.captureFrame = options.captureFrame ?? (() => captureX11Frame(this.display));
    this.startDisplay = options.startDisplay ?? (() => startX11Display(this.display, this.width, this.height));
    this.stopDisplay = options.stopDisplay ?? stopX11Display;
    this.browserProfile = options.browserProfile ?? DEFAULT_BROWSER_PROFILE;
    this.cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
    this.browserStartupTimeoutMs = Math.min(60_000, Math.max(5_000, options.browserStartupTimeoutMs ?? 30_000));
    this.browserCloseTimeoutMs = Math.min(15_000, Math.max(1_000, options.browserCloseTimeoutMs ?? 5_000));
    this.startBrowser = options.startBrowser ?? (() => startHeadedBrowser({
      display: this.display, width: this.width, height: this.height,
      profile: this.browserProfile, cdpEndpoint: this.cdpEndpoint,
      timeoutMs: this.browserStartupTimeoutMs,
    }));
    this.stopBrowser = options.stopBrowser ?? ((handle) => stopHeadedBrowser(handle, this.browserCloseTimeoutMs));
    this.runCommand = options.runCommand ?? runCommand;
    this.clients = new Map();
    this.nextClientId = 1;
    this.captureTask = undefined;
    this.displayHandle = undefined;
    this.browserHandle = undefined;
    this.state = "stopped";
    this.error = undefined;
    this.controlLease = undefined;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.controlExpiryTimer = undefined;
    this.controlInputQueue = Promise.resolve();
    this.controlCleanupPending = false;
  }

  async start() {
    if (this.state === "ready" || this.state === "paused") return this.status();
    if (this.state === "starting") return this.starting;
    this.state = "starting";
    this.starting = Promise.resolve().then(() => this.startDisplay()).then(async (handle) => {
      this.displayHandle = handle;
      process.env.DISPLAY = this.display;
      this.browserHandle = await this.startBrowser();
      this.state = "paused";
      this.error = undefined;
      return this.status();
    }).catch((error) => {
      if (this.browserHandle) awaitCleanup(() => this.stopBrowser(this.browserHandle));
      if (this.displayHandle) awaitCleanup(() => this.stopDisplay(this.displayHandle));
      this.browserHandle = undefined;
      this.displayHandle = undefined;
      this.state = "error";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  status() {
    return {
      state: this.state,
      display: this.display,
      width: this.width,
      height: this.height,
      viewers: this.clients.size,
      captureActive: Boolean(this.captureTask),
      browser: this.browserHandle ? "ready" : (this.state === "error" ? "unavailable" : "stopped"),
      cdpEndpoint: this.browserHandle ? this.cdpEndpoint : undefined,
      error: this.error,
      control: this.controlStatus(),
    };
  }

  /** Acquire the exclusive human input lease. Expiry never resumes an agent. */
  acquireControl(owner = "human") {
    this.expireControlLease();
    if (this.controlCleanupPending) throw httpError(409, "desktop control cleanup is still in progress");
    if (this.controlLease) throw httpError(409, "desktop is already controlled");
    const token = randomUUID();
    this.controlLease = { token, owner: String(owner).slice(0, 120), expiresAt: Date.now() + CONTROL_LEASE_MS };
    this.armControlExpiry();
    return this.controlStatus(true);
  }

  renewControl(token) {
    this.requireControl(token);
    this.controlLease.expiresAt = Date.now() + CONTROL_LEASE_MS;
    this.armControlExpiry();
    return this.controlStatus(true);
  }

  async releaseControl(token) {
    this.requireControl(token);
    clearTimeout(this.controlExpiryTimer);
    this.controlExpiryTimer = undefined;
    this.controlCleanupPending = true;
    try {
      await this.controlInputQueue;
      await this.releaseHeldInput();
      this.controlLease = undefined;
    } finally {
      this.controlCleanupPending = false;
    }
    return this.controlStatus();
  }

  controlStatus(includeToken = false) {
    this.expireControlLease();
    if (!this.controlLease) return { active: false, ...(this.controlCleanupPending ? { cleaning: true } : {}) };
    return {
      active: true,
      owner: this.controlLease.owner,
      expiresAt: new Date(this.controlLease.expiresAt).toISOString(),
      ...(includeToken ? { token: this.controlLease.token } : {}),
    };
  }

  async input(token, action) {
    const operation = this.controlInputQueue.then(() => this.performInput(token, action));
    this.controlInputQueue = operation.catch(() => undefined);
    return operation;
  }

  async performInput(token, action) {
    this.requireControl(token);
    switch (action?.type) {
      case "move": {
        const { x, y } = normalizedPoint(action);
        await this.runCommand("xdotool", ["mousemove", String(Math.round(x * (this.width - 1))), String(Math.round(y * (this.height - 1)))], undefined, this.display);
        return { ok: true };
      }
      case "click": {
        const { x, y } = normalizedPoint(action);
        const button = action.button ?? "left";
        if (!["left", "middle", "right"].includes(button)) throw httpError(400, "invalid mouse button");
        const clicks = action.clicks ?? 1;
        if (!Number.isInteger(clicks) || clicks < 1 || clicks > 2) throw httpError(400, "invalid click count");
        await this.runCommand("xdotool", ["mousemove", String(Math.round(x * (this.width - 1))), String(Math.round(y * (this.height - 1))), "click", "--repeat", String(clicks), String({ left: 1, middle: 2, right: 3 }[button])], undefined, this.display);
        return { ok: true };
      }
      case "down":
      case "up": {
        const { x, y } = normalizedPoint(action);
        const button = action.button ?? "left";
        if (!["left", "middle", "right"].includes(button)) throw httpError(400, "invalid mouse button");
        await this.runCommand("xdotool", ["mousemove", String(Math.round(x * (this.width - 1))), String(Math.round(y * (this.height - 1))), action.type === "down" ? "mousedown" : "mouseup", String({ left: 1, middle: 2, right: 3 }[button])], undefined, this.display);
        if (action.type === "down") this.heldButtons.add(button); else this.heldButtons.delete(button);
        return { ok: true };
      }
      case "scroll": {
        const deltaX = finiteBound(action.deltaX ?? 0, -10_000, 10_000, "deltaX");
        const deltaY = finiteBound(action.deltaY ?? 0, -10_000, 10_000, "deltaY");
        if (!deltaX && !deltaY) throw httpError(400, "scroll delta is required");
        const verticalButton = deltaY < 0 ? 4 : 5;
        const horizontalButton = deltaX < 0 ? 6 : 7;
        const count = Math.min(100, Math.max(1, Math.round(Math.abs(deltaY || deltaX) / 100)));
        const button = deltaY ? verticalButton : horizontalButton;
        await this.runCommand("xdotool", ["click", "--repeat", String(count), String(button)], undefined, this.display);
        return { ok: true };
      }
      case "key": {
        const key = allowedKey(action.key, action.action ?? "press");
        const x11Key = x11KeyName(key);
        const keyCommand = action.action === "down" ? "keydown" : action.action === "up" ? "keyup" : "key";
        await this.runCommand("xdotool", [keyCommand, ...(action.action === "press" ? ["--clearmodifiers"] : []), x11Key], undefined, this.display);
        if (action.action === "down") this.heldKeys.add(x11Key); else if (action.action === "up") this.heldKeys.delete(x11Key);
        return { ok: true };
      }
      case "text": {
        if (typeof action.text !== "string" || !action.text.length || action.text.length > MAX_CONTROL_TEXT) throw httpError(400, "text must contain 1 to 16000 characters");
        // Feed text over stdin so secrets never appear in argv or process listings.
        await this.runCommand("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], action.text, this.display);
        return { ok: true };
      }
      case "clipboard": {
        if (action.action === "write") {
          if (typeof action.text !== "string" || action.text.length > MAX_CONTROL_TEXT) throw httpError(400, "clipboard text is invalid");
          await this.runCommand("xclip", ["-selection", "clipboard", "-in"], action.text, this.display);
          return { ok: true };
        }
        if (action.action === "read") return { text: await this.runCommand("xclip", ["-selection", "clipboard", "-out"], undefined, this.display) };
        throw httpError(400, "clipboard action must be read or write");
      }
      case "releaseHeldKeys":
        await this.releaseHeldInput();
        return { ok: true };
      default:
        throw httpError(400, "unsupported desktop input action");
    }
  }

  async stream() {
    await this.start();
    if (this.clients.size >= this.maxViewers) throw httpError(429, "desktop viewer limit reached");
    const id = this.nextClientId++;
    let client;
    const stream = new ReadableStream({
      start: (controller) => {
        client = { controller };
        this.clients.set(id, client);
        this.state = "ready";
        this.startCaptureLoop();
      },
      cancel: () => this.removeClient(id),
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "cache-control": "no-store, no-cache, must-revalidate",
        connection: "close",
        "x-desktop-state": this.state,
      },
    });
  }

  async close() {
    for (const client of this.clients.values()) client.controller.close();
    this.clients.clear();
    if (this.captureTask) await this.captureTask.catch(() => undefined);
    this.captureTask = undefined;
    clearTimeout(this.controlExpiryTimer);
    this.controlExpiryTimer = undefined;
    this.controlCleanupPending = true;
    await this.controlInputQueue.catch(() => undefined);
    await this.releaseHeldInput();
    this.controlLease = undefined;
    this.controlCleanupPending = false;
    await this.stopBrowser(this.browserHandle);
    this.browserHandle = undefined;
    await this.stopDisplay(this.displayHandle);
    this.displayHandle = undefined;
    this.state = "stopped";
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  requireControl(token) {
    this.expireControlLease();
    if (!this.controlLease || typeof token !== "string" || token !== this.controlLease.token) throw httpError(409, "desktop control lease is required");
  }

  expireControlLease() {
    if (this.controlLease && this.controlLease.expiresAt <= Date.now()) {
      clearTimeout(this.controlExpiryTimer);
      this.controlExpiryTimer = undefined;
      this.controlLease = undefined;
      this.controlCleanupPending = true;
      const cleanup = this.controlInputQueue.then(() => this.releaseHeldInput());
      this.controlInputQueue = cleanup.catch(() => undefined);
      void cleanup.then(() => { this.controlCleanupPending = false; }, () => { this.controlCleanupPending = false; });
    }
  }

  armControlExpiry() {
    clearTimeout(this.controlExpiryTimer);
    this.controlExpiryTimer = setTimeout(() => {
      if (!this.controlLease || this.controlLease.expiresAt > Date.now()) return this.armControlExpiry();
      this.controlLease = undefined;
      this.controlExpiryTimer = undefined;
      this.controlCleanupPending = true;
      const cleanup = this.controlInputQueue.then(() => this.releaseHeldInput());
      this.controlInputQueue = cleanup.catch(() => undefined);
      void cleanup.then(() => { this.controlCleanupPending = false; }, () => { this.controlCleanupPending = false; });
    }, Math.max(0, this.controlLease ? this.controlLease.expiresAt - Date.now() + 25 : CONTROL_LEASE_MS));
    this.controlExpiryTimer.unref?.();
  }

  async releaseHeldInput() {
    const commands = [];
    for (const key of this.heldKeys) commands.push(this.runCommand("xdotool", ["keyup", key], undefined, this.display).catch(() => undefined));
    for (const button of this.heldButtons) commands.push(this.runCommand("xdotool", ["mouseup", String({ left: 1, middle: 2, right: 3 }[button])], undefined, this.display).catch(() => undefined));
    this.heldKeys.clear();
    this.heldButtons.clear();
    await Promise.all(commands);
  }

  startCaptureLoop() {
    if (this.captureTask) return;
    this.captureTask = (async () => {
      while (this.clients.size > 0) {
        try {
          const image = await this.captureFrame();
          if (!(image instanceof Uint8Array) || image.byteLength === 0) throw new Error("desktop capture returned no JPEG frame");
          const header = new TextEncoder().encode(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.byteLength}\r\n\r\n`);
          const suffix = new TextEncoder().encode("\r\n");
          for (const [id, client] of this.clients) {
            try {
              if (client.controller.desiredSize !== null && client.controller.desiredSize <= 0) continue;
              client.controller.enqueue(concat(header, image, suffix));
            } catch {
              this.clients.delete(id);
            }
          }
          await delay(1000 / this.fps);
        } catch (error) {
          this.state = "error";
          this.error = error instanceof Error ? error.message : String(error);
          for (const client of this.clients.values()) client.controller.error(error);
          this.clients.clear();
          break;
        }
      }
    })().finally(() => { this.captureTask = undefined; if (this.clients.size === 0 && this.state === "ready") this.state = "paused"; });
  }
}

async function startHeadedBrowser({ display, width, height, profile, cdpEndpoint, timeoutMs }) {
  const port = new URL(cdpEndpoint).port || "9222";
  const context = await withTimeout(chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width, height },
    env: { ...process.env, DISPLAY: display },
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`],
  }), timeoutMs, "headed browser startup timed out");
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await withTimeout(page.setContent(WELCOME_HTML, { waitUntil: "domcontentloaded" }), timeoutMs, "desktop welcome page timed out");
    return { context, page, cdpEndpoint };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function stopHeadedBrowser(handle, timeoutMs) {
  if (!handle?.context) return;
  await withTimeout(handle.context.close(), timeoutMs, "headed browser close timed out").catch(() => undefined);
  // Persistent contexts can return before Chrome has flushed its profile
  // journal. Wait for the CDP listener to disappear before allowing tar/R2
  // checkpointing to read the profile, otherwise tar reports a file changing
  // underneath it and the archive would be inconsistent.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(handle.cdpEndpoint); }
    catch { return; }
    await delay(50);
  }
}

function normalizedPoint(action) {
  const x = finiteBound(action?.x, 0, 1, "x");
  const y = finiteBound(action?.y, 0, 1, "y");
  return { x, y };
}

function finiteBound(value, minimum, maximum, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw httpError(400, `${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function allowedKey(value, action) {
  if (typeof value !== "string" || !value || value.length > 80) throw httpError(400, "key is invalid");
  if (!["press", "down", "up"].includes(action)) throw httpError(400, "key action is invalid");
  if (value.includes("+")) {
    if (action !== "press" || !ALLOWED_SHORTCUTS.has(value)) throw httpError(400, "shortcut is not allowed");
    return value;
  }
  if (!(MODIFIERS.has(value) || NAVIGATION_KEYS.has(value) || /^F(?:[1-9]|1[0-2])$/.test(value) || /^[a-zA-Z0-9]$/.test(value))) throw httpError(400, "key is not allowed");
  return value;
}

function x11KeyName(value) {
  if (value.includes("+")) return value.split("+").map((part) => X11_KEYS.get(part) ?? part.toLowerCase()).join("+");
  return X11_KEYS.get(value) ?? value;
}

function runCommand(command, args, input, display) {
  return new Promise((resolve, reject) => {
    // xclip forks a clipboard owner. Its inherited output pipes must not keep
    // this request open after the parent exits. Input still travels over stdin.
    const clipboardOwner = command === "xclip" && args.includes("-in");
    const child = spawn(command, args, { env: { ...process.env, DISPLAY: display }, stdio: ["pipe", clipboardOwner ? "ignore" : "pipe", clipboardOwner ? "ignore" : "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(httpError(504, `${command} timed out`)); }, 5_000);
    child.stdout?.on("data", (chunk) => { size += chunk.byteLength; if (size <= 256 * 1024) stdout.push(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.reduce((n, part) => n + part.byteLength, 0) <= 32 * 1024) stderr.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once(clipboardOwner ? "exit" : "close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(httpError(502, `${command} failed: ${Buffer.concat(stderr).toString().slice(0, 400)}`));
      resolve(Buffer.concat(stdout).toString());
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function awaitCleanup(fn) { Promise.resolve().then(fn).catch(() => undefined); }

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function startX11Display(display, width, height) {
  const displayNumber = display.replace(/^:/, "").split(".")[0];
  const socket = `/tmp/.X11-unix/X${displayNumber}`;
  let xvfb = null;
  if (!fs.existsSync(socket)) {
    xvfb = spawn("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac"], { stdio: "ignore" });
    const spawnError = new Promise((_, reject) => xvfb.once("error", reject));
    await Promise.race([waitFor(() => fs.existsSync(socket), 5_000), spawnError]);
  }
  const windowManager = spawn("fluxbox", ["-display", display, "-no-slit", "-no-toolbar"], { stdio: "ignore", env: { ...process.env, DISPLAY: display } });
  windowManager.once("error", () => undefined);
  return { xvfb, windowManager };
}

async function captureX11Frame(display) {
  const xwd = spawn("xwd", ["-root", "-silent", "-display", display], { stdio: ["ignore", "pipe", "ignore"] });
  const convert = spawn("convert", ["xwd:-", "-quality", "72", "jpeg:-"], { stdio: ["pipe", "pipe", "ignore"] });
  const chunks = [];
  let size = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error("X11 capture timed out")), 5_000);
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); xwd.kill("SIGKILL"); convert.kill("SIGKILL"); reject(error); };
    xwd.once("error", fail); convert.once("error", fail);
    convert.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) return fail(new Error("X11 JPEG frame exceeded size limit"));
      chunks.push(new Uint8Array(chunk));
    });
    convert.once("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const result = concat(...chunks);
      if (code !== 0 || !result.byteLength) return reject(new Error("X11 capture produced no JPEG frame"));
      resolve(result);
    });
    xwd.stdout.pipe(convert.stdin);
  });
}

async function stopX11Display(handle) {
  if (!handle) return;
  const stopping = [];
  for (const process of [handle.windowManager, handle.xvfb]) {
    if (!process || process.killed) continue;
    stopping.push(new Promise((resolve) => { process.once("exit", resolve); process.once("error", resolve); setTimeout(resolve, 1_000); }));
    process.kill("SIGTERM");
  }
  await Promise.all(stopping);
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  throw new Error("Xvfb did not become ready");
}

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
