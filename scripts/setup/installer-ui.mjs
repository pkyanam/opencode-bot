import { openSync } from "node:fs";
import { ReadStream as TTYReadStream } from "node:tty";

const ESC = "\u001b[";
const COLORS = {
  blue: `${ESC}38;5;75m`,
  green: `${ESC}38;5;114m`,
  yellow: `${ESC}38;5;179m`,
  red: `${ESC}38;5;203m`,
  muted: `${ESC}38;5;245m`,
  reset: `${ESC}0m`,
};

/** Remove terminal controls from external strings before rendering them. */
export function renderText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r?\n/g, " ");
}

export function ttyAvailable({ input = process.stdin, output = process.stdout } = {}) {
  return Boolean(input?.isTTY && output?.isTTY);
}

function write(output, text) {
  if (output?.write) output.write(text);
}

function color(name, text) {
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

/**
 * Lightweight setup UI. It never asks for input unless both streams are TTYs.
 * `tty` can be a separately opened /dev/tty stream when stdin is piped.
 */
export function createInstallerUI({ input = process.stdin, output = process.stdout, tty = input, interactive = ttyAvailable({ input: tty, output }), colors = Boolean(output?.isTTY) } = {}) {
  let raw = false;
  let closed = false;
  let panelLines = 0;
  const paint = (name, value) => colors ? color(name, value) : value;
  const say = (message = "") => write(output, `${message}\n`);
  const ui = {
    interactive: Boolean(interactive && tty?.on),
    step(label) { say(`${paint("blue", "•")} ${renderText(label)}`); },
    progress(label) { say(`${paint("muted", "  …")} ${renderText(label)}`); },
    success(label) { say(`${paint("green", "✓")} ${renderText(label)}`); },
    error(label) { say(`${paint("red", "✗")} ${renderText(label)}`); },
    warning(label) { say(`${paint("yellow", "!")} ${renderText(label)}`); },
    startedAt: Date.now(),
    panel({ provider = "Cloudflare", stage = "Starting", startedAt = ui.startedAt } = {}) {
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const lines = ["OpenCode Bot", `Provider: ${renderText(provider)}`, `Stage: ${renderText(stage)}`, `Elapsed: ${elapsed}s`];
      const width = Math.max(...lines.map(line => line.length), 12) + 2;
      if (panelLines && ui.interactive) write(output, `${ESC}${panelLines}A${ESC}0J`);
      say(paint("blue", `┌${"─".repeat(width)}┐`));
      for (const line of lines) say(paint("blue", `│ ${line.padEnd(width - 1)}│`));
      say(paint("blue", `└${"─".repeat(width)}┘`));
      panelLines = lines.length + 2;
    },
    cleanup() {
      if (closed) return;
      closed = true;
      if (raw && typeof tty.setRawMode === "function") tty.setRawMode(false);
      if (ui.interactive || raw) write(output, `${ESC}?25h`);
    },
    async select(label, choices, { defaultIndex = 0 } = {}) {
      const values = Array.isArray(choices) ? choices.map(value => typeof value === "string" ? { label: value, value } : value) : [];
      if (!values.length) throw new Error("select requires at least one choice");
      const fallback = Math.min(Math.max(defaultIndex, 0), values.length - 1);
      if (!ui.interactive) return values[fallback].value;
      let selected = fallback;
      const draw = (initial = false) => {
        if (!initial) write(output, `${ESC}${values.length + 1}A${ESC}0J`);
        say(renderText(label));
        for (let index = 0; index < values.length; index += 1) {
          const marker = index === selected ? paint("blue", ">") : " ";
          say(`${marker} ${index + 1}. ${renderText(values[index].label)}`);
        }
      };
      draw(true);
      write(output, `${ESC}?25l`);
      if (typeof tty.setRawMode === "function") { tty.setRawMode(true); raw = true; }
      return await new Promise((resolve, reject) => {
        let buffer = "";
        const finish = (error, value) => {
          tty.off?.("data", onData); tty.off?.("error", onError);
          if (raw && typeof tty.setRawMode === "function") { tty.setRawMode(false); raw = false; }
          write(output, `${ESC}?25h`);
          if (error) reject(error); else resolve(value);
        };
        const onError = error => finish(error);
        const onData = chunk => {
          buffer += Buffer.from(chunk).toString("utf8");
          if (buffer.includes("\u0003")) return finish(new Error("selection interrupted"));
          if (buffer.includes("\r") || buffer.includes("\n")) return finish(undefined, values[selected].value);
          if (buffer.includes("\u001b[A") || buffer.includes("k")) selected = (selected + values.length - 1) % values.length;
          else if (buffer.includes("\u001b[B") || buffer.includes("j")) selected = (selected + 1) % values.length;
          else { const number = Number(buffer.slice(-1)); if (number >= 1 && number <= values.length) selected = number - 1; else return; }
          buffer = ""; draw(false);
        };
        tty.on("data", onData); tty.once?.("error", onError);
      });
    },
  };
  return ui;
}

export function openInstallerTTY({ output = process.stderr } = {}) {
  if (process.platform === "win32") return undefined;
  try {
    const fd = openSync("/dev/tty", "r+");
    const tty = new TTYReadStream(fd);
    tty.resume();
    return { tty, output, close: () => { tty.destroy(); } };
  } catch { return undefined; }
}

export function installCleanup(ui, { signals = ["SIGINT", "SIGTERM"] } = {}) {
  const onSignal = signal => { ui.cleanup(); process.kill(process.pid, signal); };
  for (const signal of signals) process.once(signal, onSignal);
  return () => { for (const signal of signals) process.off(signal, onSignal); ui.cleanup(); };
}
