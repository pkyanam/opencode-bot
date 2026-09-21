import { createHash } from "node:crypto";
import { mkdirSync, statSync, openSync, readSync, closeSync, writeSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

export const CRANE_VERSION = "v0.20.7";
export const CRANE_SHA256 = {
  "linux/x64": "8ef3564d264e6b5ca93f7b7f5652704c4dd29d33935aff6947dd5adefd05953e",
  "linux/arm64": "b04ee6e4904d9219c76383f5b73521a63f69ecc93c0b1840846eebfd071a6355",
  "darwin/x64": "69af8da281cd2cd56245bf178de8719bbcdd2ffdeae46b4c621c02bfc6f75e22",
  "darwin/arm64": "210da17a7269a9904a9b6797efbf97f4b1e5567c0962f168d1489a7bd375f14a"
};
export const MANIFEST_SCHEMA = 1;
export const DIRECT_IMAGE_SCHEMA = 2;

export function validateManifest(manifest, { version } = {}) {
  if (!manifest || ![MANIFEST_SCHEMA, DIRECT_IMAGE_SCHEMA].includes(manifest.schemaVersion)) throw new Error("unsupported release manifest schema");
  if ((version && manifest.version !== version) || !/^v\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`release manifest version must be ${version ?? "a semver tag"}`);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("release manifest commit must be a 40 character SHA");
  if (manifest.platform !== "linux/amd64") throw new Error("release archive platform must be linux/amd64");
  if (manifest.opencodeVersion !== "2.0.11" || manifest.sandboxVersion !== "0.12.9") throw new Error("release runtime versions do not match this installer");
  if (![manifest.opencodeVersion, manifest.sandboxVersion].every(value => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value))) throw new Error("invalid runtime versions");
  if (manifest.schemaVersion === DIRECT_IMAGE_SCHEMA) {
    if (!/^docker\.io\/preethamk\/opencode-bot@sha256:[0-9a-f]{64}$/.test(manifest.image?.reference ?? "")) throw new Error("schema 2 image reference must be the pinned Docker Hub image");
  } else if (!manifest.imageArchive || manifest.imageArchive.file !== "computer-image.tar.gz" || !/^[0-9a-f]{64}$/.test(manifest.imageArchive.sha256) || !Number.isSafeInteger(manifest.imageArchive.size) || manifest.imageArchive.size <= 0 || manifest.imageArchive.size >= 2147483648) throw new Error("invalid image archive metadata");
  return manifest;
}

export function githubReleaseUrl(version, file) {
  if (!/^v\d+\.\d+\.\d+$/.test(version) || file !== "computer-image.tar.gz") throw new Error("invalid GitHub release asset");
  return `https://github.com/pkyanam/opencode-bot/releases/download/${version}/${file}`;
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function verifyArchive(file, archive) {
  const size = statSync(file).size;
  if (size !== archive.size) throw new Error(`image archive size mismatch (expected ${archive.size}, got ${size})`);
  const actual = sha256File(file);
  if (actual !== archive.sha256) throw new Error("image archive sha256 mismatch");
  return { size, sha256: actual };
}

export async function downloadReleaseArchive(manifest, destination, fetchImpl = fetch) {
  validateManifest(manifest);
  const response = await fetchImpl(githubReleaseUrl(manifest.version, manifest.imageArchive.file), { redirect: "follow", signal: AbortSignal.timeout(3600000) });
  if (!response.ok) throw new Error(`release archive download failed (HTTP ${response.status})`);
  if (response.url && !["github.com", "release-assets.githubusercontent.com"].includes(new URL(response.url).hostname)) throw new Error("release archive redirected outside GitHub");
  if (!response.body) throw new Error("release archive response is empty");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.partial`;
  const fd = openSync(temporary, "wx", 0o600);
  let closed = false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > manifest.imageArchive.size) throw new Error("image archive size mismatch");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    }
    if (size !== manifest.imageArchive.size) throw new Error("image archive size mismatch");
    if (hash.digest("hex") !== manifest.imageArchive.sha256) throw new Error("image archive sha256 mismatch");
    closeSync(fd); closed = true;
    renameSync(temporary, destination);
    return destination;
  } finally {
    if (!closed) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function currentCommit(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot determine checkout commit");
  return result.stdout.trim();
}

export function assertSourceCommit(manifest, cwd) {
  if (currentCommit(cwd) !== manifest.commit) throw new Error(`release commit ${manifest.commit} does not match this checkout`);
}

export function craneAsset() {
  const key = `${process.platform}/${process.arch}`;
  const names = { "linux/x64": "Linux_x86_64", "linux/arm64": "Linux_arm64", "darwin/x64": "Darwin_x86_64", "darwin/arm64": "Darwin_arm64" };
  if (!names[key]) throw new Error(`unsupported crane platform ${key}`);
  return { url: `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_${names[key]}.tar.gz`, sha256: CRANE_SHA256[key] };
}
