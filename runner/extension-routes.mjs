import { parse as parseYaml } from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 10_000_000;

/**
 * Native skill installation boundary. The caller must have already reviewed
 * the repository and validated its GitHub provenance. This route writes
 * inert skill files only; it never runs package scripts or modifies config.
 */
export function createExtensionRoutes({ workspace, updateConfiguration }) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("workspace must be absolute");
  async function handle(req, res) {
    const url = new URL(req.url, "http://runner");
    if (url.pathname !== "/extensions/install") return false;
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    try {
      const input = await readJson(req);
      const result = await (typeof updateConfiguration === "function" ? updateConfiguration(() => installSkill(input)) : installSkill(input));
      return send(res, 201, result);
    } catch (error) {
      return send(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: error?.message ?? String(error) });
    }
  }
  async function installSkill(input) {
    if (!Array.isArray(input?.files) || input.files.length < 1 || input.files.length > MAX_FILES) throw httpError(400, "files must be a bounded non-empty array");
    const files = [];
    let total = 0;
    for (const item of input.files) {
      if (!item || typeof item.path !== "string" || (typeof item.content !== "string" && typeof item.contentBase64 !== "string")) throw httpError(400, "each file requires path and content");
      const relative = safeFilePath(item.path);
      if (item.contentBase64 !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw httpError(400, "invalid base64 file");
      const content = item.contentBase64 !== undefined ? Buffer.from(item.contentBase64, "base64") : Buffer.from(item.content, "utf8");
      const bytes = content.length;
      if (bytes > MAX_FILE_BYTES) throw httpError(413, "skill file is too large");
      total += bytes;
      if (total > MAX_TOTAL_BYTES) throw httpError(413, "skill payload is too large");
      files.push({ relative, content });
    }
    const entry = files.find((item) => item.relative === "SKILL.md");
    if (!entry) throw httpError(400, "SKILL.md is required");
    const metadata = parseSkillMetadata(entry.content.toString("utf8"));
    if (input.skillName !== undefined && input.skillName !== metadata.name) throw httpError(400, "skillName does not match SKILL.md");
    const target = path.join(workspace, ".agents", "skills", metadata.name);
    const parent = path.dirname(target);
    for (const directory of [path.join(workspace, ".agents"), parent]) {
      try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw httpError(400, "skill directory must not be a symlink"); }
      catch (error) { if (error.code !== "ENOENT") throw error; await fs.mkdir(directory, {mode:0o700}); }
    }
    try { await fs.lstat(target); throw httpError(409, "skill is already installed"); } catch (error) { if (error?.statusCode) throw error; if (error?.code !== "ENOENT") throw error; }
    const temporary = `${target}.install-${randomUUID()}`;
    try {
      await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const filename = path.join(temporary, file.relative);
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await fs.writeFile(filename, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { installed: true, name: metadata.name, path: path.relative(workspace, target), files: files.map((file) => file.relative), metadata };
  }
  return { handle, installSkill };
}

function safeFilePath(value) {
  if (!value || value.length > 500 || path.posix.isAbsolute(value) || value.includes("\\")) throw httpError(400, "unsafe skill file path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw httpError(400, "unsafe skill file path");
  return parts.join("/");
}

function parseSkillMetadata(markdown) {
  const match = markdown.match(/^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw httpError(400, "SKILL.md must start with YAML frontmatter");
  let fields;
  try { fields = parseYaml(match[1], {maxAliasCount:10}); } catch { throw httpError(400, "invalid YAML frontmatter"); }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw httpError(400, "frontmatter must be a mapping");
  const values = new Map(Object.entries(fields).filter(([,value])=>typeof value === "string"));
  const name = values.get("name") ?? "", description = values.get("description") ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--") || !description || description.length > 1024) throw httpError(400, "SKILL.md has invalid Agent Skills metadata");
  return { name, description, ...(values.get("license") ? { license: values.get("license") } : {}) };
}

function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; }
async function readJson(req) { let data = ""; for await (const chunk of req) { data += chunk; if (data.length > 12_000_000) throw httpError(413, "request body too large"); } try { return data ? JSON.parse(data) : {}; } catch { throw httpError(400, "invalid JSON"); } }
