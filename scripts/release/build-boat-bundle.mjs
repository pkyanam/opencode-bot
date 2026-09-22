#!/usr/bin/env node
/** Build the standalone, no-Cloudflare Boat release archive. */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const value = (flag) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
const outputDir = resolve(root, value("--output-dir") || ".tmp/boat-release");
const skipBuild = process.argv.includes("--skip-build");
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: options.silent ? "pipe" : "inherit", encoding: "utf8", timeout: options.timeout ?? 1800000 }); if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? "unknown"})`); return result; };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (!skipBuild) {
  run("npm", ["run", "build"]);
  run(process.execPath, ["packages/control-local/src/build.mjs"]);
}
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = value("--version") || `v${packageJson.version}`;
const commit = value("--commit") || run("git", ["rev-parse", "HEAD"], { silent: true }).stdout.trim();
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("Boat bundle version must be vSemVer");
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Boat bundle commit must be a full SHA");
for (const required of ["packages/control-local/dist/control-local.js", "runner/package-lock.json", "boat/setup.sh", "boat/control-start.mjs", "boat/opencode-bot.service"]) if (!(await stat(join(root, required)).catch(() => null))) throw new Error(`missing Boat bundle input: ${required}`);

await rm(outputDir, { recursive: true, force: true });
const stage = join(outputDir, "stage");
await mkdir(stage, { recursive: true });
await writeFile(join(stage, "boat-release.json"), JSON.stringify({version, commit}));
await cp(join(root, "packages/control-local/dist/control-local.js"), join(stage, "control-local.js"));
await cp(join(root, "packages/control-local/dist/control-local.js.map"), join(stage, "control-local.js.map")).catch(() => {});
await cp(join(root, "runner"), join(stage, "runner"), { recursive: true, filter: (source) => !/\/node_modules(?:\/|$)/.test(source) });
await cp(join(root, "packages/runtime-opencode2"), join(stage, "packages/runtime-opencode2"), { recursive: true, filter: (source) => !/\/node_modules(?:\/|$)/.test(source) });
await cp(join(root, "packages/browser"), join(stage, "packages/browser"), { recursive: true, filter: (source) => !/\/node_modules(?:\/|$)/.test(source) });
await writeFile(join(stage, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
for (const file of ["README.md", "SECURITY.md"]) await cp(join(root, file), join(stage, file));
await cp(join(root, "docs"), join(stage, "docs"), { recursive: true });
await cp(join(root, "skills"), join(stage, "skills"), { recursive: true });
await cp(join(root, "apps/web/dist"), join(stage, "web"), { recursive: true });
await cp(join(root, "boat"), join(stage, "boat"), { recursive: true });
const archive = join(outputDir, "boat-bundle.tar.gz");
run("tar", ["-czf", archive, "-C", stage, "boat-release.json", "control-local.js", "control-local.js.map", "package.json", "runner", "packages", "README.md", "SECURITY.md", "docs", "skills", "web", "boat"]);
const bytes = await readFile(archive); const archiveStat = await stat(archive);
const manifest = { schemaVersion: 1, version, commit, archive: { file: "boat-bundle.tar.gz", size: archiveStat.size, sha256: sha256(bytes) }, runtime: { node: ">=24", cloudflare: false, docker: false, controlEntrypoint: "boat/control-start.mjs", computerProvider: "LocalComputerProvider" } };
await writeFile(join(outputDir, "boat-bundle-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Boat bundle: ${archive}`);
console.log(`Manifest: ${join(outputDir, "boat-bundle-manifest.json")}`);
