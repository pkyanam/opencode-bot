import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const DEFAULT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "node_modules/.bin/opencode2");
const MAX_OUTPUT = 256 * 1024;
const MAX_PACKAGE = 214;
const PACKAGE = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Native OpenCode plugin management boundary. Only exact npm package@version
 * specs are accepted; the CLI runs with a private HOME/XDG state directory.
 */
export function createPluginRoutes({ workspace, updateConfiguration, reloadRuntime, cliPath = DEFAULT_CLI, execFile: run = execFile, runtimeRoot } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("workspace must be absolute");
  const root = runtimeRoot || path.join(workspace, ".opencode-plugin-runtime");

  async function handle(req, res) {
    const url = new URL(req.url, "http://runner");
    if (url.pathname !== "/extensions/plugins") return false;
    try {
      if (req.method === "GET") return send(res, 200, await list());
      if (req.method === "POST") {
        const input = await readJson(req);
        const result = await mutate("add", input?.package);
        return send(res, 201, result);
      }
      if (req.method === "DELETE") {
        const input = await readJson(req);
        const result = await mutate("remove", input?.package || url.searchParams.get("package"));
        return send(res, 200, result);
      }
      return send(res, 405, { error: "method not allowed" });
    } catch (error) {
      return send(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: publicError(error) });
    }
  }

  async function list() {
    let config;
    try { config = JSON.parse(await fs.readFile(path.join(root, "config/opencode/opencode.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {plugins:[]}; throw new Error("Could not read native plugin configuration"); }
    return {plugins:(config.plugins ?? []).map(value => typeof value === "string" ? value : value?.package).filter(value => typeof value === "string").map(value=>({package:value, removable:PACKAGE.test(value)}))};
  }

  async function mutate(command, value) {
    const spec = validatePackage(value);
    const operation = async () => {
      const result = await invoke(["plugin", command, spec]);
      if (typeof reloadRuntime === "function") await reloadRuntime();
      return { package: spec, operation: command, output: redact(result.stdout).trim() };
    };
    return typeof updateConfiguration === "function" ? updateConfiguration(operation) : operation();
  }

  async function invoke(args) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const config = path.join(root, "config"), data = path.join(root, "data"), cache = path.join(root, "cache");
    await Promise.all([config, data, cache].map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: path.join(root, "state"),
      OPENCODE_DIRECTORY: workspace,
      NODE_USE_SYSTEM_CA: "1",
      NPM_CONFIG_USERCONFIG: path.join(config, "npmrc"),
      TMPDIR: os.tmpdir(),
    };
    try {
      return await run(cliPath, args, { cwd: workspace, env, timeout: 120_000, maxBuffer: MAX_OUTPUT, windowsHide: true });
    } catch (error) {
      const wrapped = new Error("OpenCode plugin command failed");
      wrapped.statusCode = error?.code === "ETIMEDOUT" ? 504 : 502;
      wrapped.cause = error;
      throw wrapped;
    }
  }
  return { handle, list, add: (value) => mutate("add", value), remove: (value) => mutate("remove", value) };
}

export function validatePackage(value) {
  if (typeof value !== "string" || value.length > MAX_PACKAGE || !PACKAGE.test(value)) {
    const error = new Error("package must be an exact npm package@version specifier"); error.statusCode = 400; throw error;
  }
  return value;
}

function parsePlugins(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => !/^no plugins found$/i.test(line)).map((line) => ({ package: line.replace(/^[-*]\s+/, "") }));
}
function redact(value) { return String(value || "").replace(/(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]").replace(/(token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]"); }
function publicError(error) { return redact(error?.statusCode === 504 ? "plugin command timed out" : error?.statusCode === 502 ? "plugin command failed" : error?.message || "plugin operation failed"); }
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; }
async function readJson(req) { let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 16_000) { const e = new Error("request body too large"); e.statusCode = 413; throw e; } } try { return data ? JSON.parse(data) : {}; } catch { const e = new Error("invalid JSON"); e.statusCode = 400; throw e; } }
