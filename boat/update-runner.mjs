#!/usr/bin/env node
/* Root-only updater. The request file is an intentionally tiny, fixed-schema
 * capability from the app user; all paths, URLs, and setup inputs are fixed here. */
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const requestPath = "/var/lib/opencode-bot/update/state.json.request";
const statePath = "/var/lib/opencode-bot/update/state.json";
const releaseBase = "https://github.com/pkyanam/opencode-bot/releases/download";
const versionRe = /^v\d+\.\d+\.\d+$/;
const commitRe = /^[0-9a-f]{40}$/;
const shaRe = /^[0-9a-f]{64}$/;

const appUid = Number(execFileSync("/usr/bin/id", ["-u", "opencode-bot"], { encoding: "utf8" }).trim());
const appGid = Number(execFileSync("/usr/bin/id", ["-g", "opencode-bot"], { encoding: "utf8" }).trim());
async function state(value) {
  // Status is written with the app's own privileges. Even if it replaces its
  // writable directory with a symlink, this cannot write a root-owned file.
  const writer = `const fs=require('fs');const p=process.argv[1];const t=p+'.tmp-'+require('crypto').randomUUID();let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{fs.writeFileSync(t,body,{mode:384,flag:'wx'});fs.renameSync(t,p)});`;
  execFileSync(process.execPath, ['-e', writer, statePath], { uid: appUid, gid: appGid, input: JSON.stringify(value) + '\n' });
}
function trustedResponse(response) {
  const url = new URL(response.url);
  if (url.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('release redirected to an untrusted host');
  return response;
}
async function fetchBytes(url, destination, limit = 1024 * 1024 * 1024) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  trustedResponse(response);
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  const expected = Number(response.headers.get("content-length") ?? 0);
  if (expected > limit) throw new Error("release archive is too large");
  let size = 0;
  const limited = new TransformStream({ transform(chunk, controller) { size += chunk.byteLength; if (size > limit) { controller.error(new Error("release archive is too large")); return; } controller.enqueue(chunk); } });
  await pipeline(response.body.pipeThrough(limited), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  return size;
}
async function digest(path) { const h = createHash("sha256"); for await (const c of (await import("node:fs")).createReadStream(path)) h.update(c); return h.digest("hex"); }
function run(command, args, options = {}) { return new Promise((resolvePromise, reject) => { const child = spawn(command, args, { stdio: options.stdio ?? "pipe", ...options }); let out = ""; if (child.stdout) child.stdout.on("data", c => out += c); child.once("error", reject); child.once("exit", code => code === 0 ? resolvePromise(out) : reject(new Error(`${command} exited with status ${code ?? "unknown"}`))); }); }
function safeName(name) { const n = name.replaceAll("\\", "/").replace(/\/+$/, ""); return n && !n.startsWith("/") && !n.split("/").some(x => x === ".." || x === ""); }
async function extractSafe(archive, destination) {
  const names = await run("/usr/bin/tar", ["-tzf", archive]);
  for (const name of names.split("\n").filter(Boolean)) if (!safeName(name)) throw new Error("unsafe path in Boat release archive");
  const listing = await run("/usr/bin/tar", ["-tvzf", archive]);
  for (const line of listing.split("\n").filter(Boolean)) if (!["-", "d"].includes(line[0])) throw new Error("links or special files are not allowed in Boat release archive");
  await run("/usr/bin/tar", ["--extract", "--file", archive, "--directory", destination, "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"]);
}
const requestHandle = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
if ((await requestHandle.stat()).size > 4096) throw new Error("Boat update request is too large");
const raw = JSON.parse(await requestHandle.readFile("utf8"));
await requestHandle.close();
if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !== "id,version" || typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/.test(raw.id) || typeof raw.version !== "string" || !versionRe.test(raw.version)) throw new Error("invalid Boat update request");
const job = { id: raw.id, requestedVersion: raw.version, phase: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await state(job);
const work = await mkdtemp(join(tmpdir(), "opencode-bot-boat-update-"));
try {
  const manifestPath = join(work, "boat-bundle-manifest.json");
  const manifestResponse = await fetch(`${releaseBase}/${raw.version}/boat-bundle-manifest.json`, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  trustedResponse(manifestResponse);
  if (!manifestResponse.ok) throw new Error(`release manifest unavailable (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== raw.version || !commitRe.test(manifest.commit) || !manifest.archive || manifest.archive.file !== "boat-bundle.tar.gz" || !shaRe.test(manifest.archive.sha256) || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size < 1 || manifest.archive.size > 1024 * 1024 * 1024) throw new Error("invalid Boat release manifest");
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { mode: 0o600 });
  const archive = join(work, "boat-bundle.tar.gz");
  const size = await fetchBytes(`${releaseBase}/${raw.version}/boat-bundle.tar.gz`, archive);
  if (size !== manifest.archive.size || await stat(archive).then(x => x.size) !== manifest.archive.size || await digest(archive) !== manifest.archive.sha256) throw new Error("Boat release archive verification failed");
  const extracted = join(work, "bundle"); await (await import("node:fs/promises")).mkdir(extracted); await extractSafe(archive, extracted);
  const release = JSON.parse(await readFile(join(extracted, "boat-release.json"), "utf8"));
  if (!release || release.version !== manifest.version || release.commit !== manifest.commit || !commitRe.test(release.commit)) throw new Error("Boat release metadata does not match manifest");
  await run("/bin/bash", [join(extracted, "boat/setup.sh")], { stdio: "inherit", env: { ...process.env, APP_BUNDLE_DIR: resolve(extracted), APP_TOKEN_FILE: "/etc/opencode-bot/app-token" } });
  await state({ ...job, phase: "completed", updatedAt: new Date().toISOString() });
} catch (error) {
  await state({ ...job, phase: "failed", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally { await rm(work, { recursive: true, force: true }); await rm(requestPath, { force: true }); }
