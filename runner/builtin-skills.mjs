import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILTIN_SKILL_NAMES = Object.freeze(["opencode-bot-self-development"]);

/**
 * Return inert files suitable for the existing /extensions/install boundary.
 * This helper deliberately does not write files, execute skill scripts, or
 * inspect the caller's environment. The parent can pass its result to the
 * runner's atomic installer during workspace/bootstrap setup.
 */
export async function builtinSkillFiles(name, { sourceRoot = root } = {}) {
  if (!BUILTIN_SKILL_NAMES.includes(name)) throw new Error(`unknown built-in skill: ${name}`);
  const directory = path.join(sourceRoot, "skills", name);
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(directory);
  files.sort();
  const payload = [];
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    if (!relative || relative.startsWith(".") || path.isAbsolute(relative)) throw new Error("invalid built-in skill path");
    const bytes = await readFile(file);
    payload.push({ path: relative, contentBase64: bytes.toString("base64") });
  }
  if (!payload.some((file) => file.path === "SKILL.md")) throw new Error(`built-in skill ${name} is missing SKILL.md`);
  return payload;
}

export async function builtinSkillPayload(name, options) {
  const files = await builtinSkillFiles(name, options);
  return { skillName: name, files };
}

export async function listBuiltinSkills({ sourceRoot = root } = {}) {
  const result = [];
  for (const name of BUILTIN_SKILL_NAMES) {
    const files = await builtinSkillFiles(name, { sourceRoot });
    const entry = files.find((file) => file.path === "SKILL.md");
    result.push({ name, files: files.map((file) => file.path), bytes: files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, "base64").byteLength, 0), hasEntry: Boolean(entry) });
  }
  return result;
}

/** Install a bundled skill once. Existing content is user-owned and preserved. */
export async function installBuiltinSkill(installer, name, options) {
  if (!installer || typeof installer.installSkill !== "function") throw new Error("skill installer is required");
  try {
    return await installer.installSkill(await builtinSkillPayload(name, options));
  } catch (error) {
    if (error?.statusCode === 409) return { installed: false, preserved: true, name };
    throw error;
  }
}
