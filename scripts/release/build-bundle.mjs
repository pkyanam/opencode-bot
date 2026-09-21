#!/usr/bin/env node
/**
 * Build the self-contained update artifact consumed by the updater.
 *
 * This intentionally records bytes, rather than URLs or deployment settings.
 * A bundle can therefore be verified and staged before it is applied to a
 * running Worker.  Secrets and account-specific bindings remain in the live
 * deployment and are never copied into this file.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hash as blake3 } from "blake3-wasm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith("--")) args.set(value, process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i]);
}

export const CONTENT_TYPES = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".html": "text/html",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

// These values are sent as part of the Workers Assets upload metadata. Keep
// them aligned with wrangler.jsonc: the API uses snake_case here even though
// Wrangler's config parser also accepts the same names from its JSON config.
export const ASSETS_ROUTING_CONFIG = {
  not_found_handling: "single-page-application",
  run_worker_first: ["/api/*", "/internal/*"],
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesUnder(directory) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  await visit(directory);
  return found.sort();
}

function assetRecord(path, bytes) {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const extensionWithoutDot = extension.startsWith(".") ? extension.slice(1) : extension;
  return {
    path,
    contentBase64: bytes.toString("base64"),
    // This is the hash Wrangler uses for its Workers Assets manifest:
    // BLAKE3(base64(file bytes) + file extension), truncated to 128 bits.
    hash: blake3(bytes.toString("base64") + extensionWithoutDot).toString("hex").slice(0, 32),
    sha256: sha256(bytes),
    size: bytes.byteLength,
    ...(CONTENT_TYPES[extension] ? { contentType: CONTENT_TYPES[extension] } : {}),
  };
}

async function run(command, commandArgs) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function buildBundle({ output, workerDirectory, assetsDirectory, version, commit, imageReference, imageDigest, skipBuild = false }) {
  const out = resolve(root, output ?? ".tmp/update-bundle/app-bundle.json");
  const worker = resolve(root, workerDirectory ?? ".tmp/update-bundle/worker");
  const assets = resolve(root, assetsDirectory ?? "apps/web/dist");
  if (!skipBuild) {
    await run("npm", ["run", "build"]);
    await rm(worker, { recursive: true, force: true });
    await mkdir(worker, { recursive: true });
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--outdir", worker, "--containers-rollout=none"]);
  }
  // Wrangler emits a README and a source map beside the deployable module.
  // Neither is a Worker module accepted by the versions API.
  const workerFiles = (await filesUnder(worker)).filter((file) => {
    const name = relative(worker, file).replaceAll(sep, "/");
    return name !== "README.md" && !name.endsWith(".map");
  });
  const assetFiles = await filesUnder(assets);
  if (!workerFiles.some((file) => relative(worker, file).replaceAll(sep, "/") === "index.js")) throw new Error(`Wrangler bundle did not emit ${worker}/index.js`);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const deploymentConfig = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  const requiredBindings = [{ name: deploymentConfig.assets.binding, type: "assets" }, ...deploymentConfig.durable_objects.bindings.map(binding => ({name: binding.name, type: "durable_object_namespace"})), ...deploymentConfig.r2_buckets.map(binding => ({name: binding.binding, type: "r2_bucket"}))];
  const runnerPackage = JSON.parse(await readFile(join(root, "runner/package.json"), "utf8"));
  const resolvedVersion = version ?? `v${packageJson.version}`;
  const resolvedCommit = commit ?? (await runCapture("git", ["rev-parse", "HEAD"]));
  const reference = imageReference ?? process.env.IMAGE_REFERENCE;
  const digest = imageDigest ?? process.env.IMAGE_DIGEST ?? reference?.split("@").at(-1);
  if (!/^v\d+\.\d+\.\d+$/.test(resolvedVersion)) throw new Error("version must be a v* semantic version");
  if (!/^[0-9a-f]{40}$/.test(resolvedCommit)) throw new Error("commit must be a full 40 character SHA");
  if (!/^docker\.io\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(reference ?? "")) throw new Error("imageReference must be an immutable Docker Hub digest reference");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new Error("imageDigest must be a sha256 digest");
  const moduleRecords = [];
  for (const file of workerFiles) {
    const name = relative(worker, file).replaceAll(sep, "/");
    moduleRecords.push({ name, contentBase64: (await readFile(file)).toString("base64"), contentType: /\.m?js$/.test(name) ? "application/javascript+module" : CONTENT_TYPES[name.slice(name.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream" });
  }
  const assetRecords = [];
  for (const file of assetFiles) {
    const name = relative(assets, file).replaceAll(sep, "/");
    assetRecords.push(assetRecord(name, await readFile(file)));
  }
  const bundle = {
    schemaVersion: 1,
    version: resolvedVersion,
    commit: resolvedCommit,
    worker: {
      mainModule: "index.js",
      modules: moduleRecords,
      compatibilityDate: "2026-09-20",
      compatibilityFlags: ["nodejs_compat"],
      metadata: { assets: { config: ASSETS_ROUTING_CONFIG } },
    },
    assets: assetRecords,
    computerImage: { reference, digest },
    runtime: { opencodeVersion: runnerPackage.dependencies["@opencode/cli"], sandboxVersion: packageJson.dependencies["@cloudflare/sandbox"] },
  };
  // The identity hash covers the canonical bundle payload without the hash
  // itself, avoiding a recursive self-hash while allowing the updater to bind
  // the downloaded contents to the release identity.
  bundle.bundleSha256 = sha256(Buffer.from(JSON.stringify(bundle)));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return bundle;
}

async function runCapture(command, commandArgs) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolvePromise, reject) => execFile(command, commandArgs, { cwd: root, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolvePromise(stdout.trim())));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildBundle({ output: args.get("--output"), version: args.get("--version"), commit: args.get("--commit"), imageReference: args.get("--image-reference"), imageDigest: args.get("--image-digest"), skipBuild: args.has("--skip-build") });
}
