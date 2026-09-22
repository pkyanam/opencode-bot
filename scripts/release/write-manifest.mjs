import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--output", "--version", "--commit", "--digest", "--reference"]) if (!args.get(key)) throw new Error(key + " is required");
const commit = args.get("--commit"), digest = args.get("--digest"), version = args.get("--version"), reference = args.get("--reference"), fingerprint = args.get("--image-fingerprint");
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full 40 character SHA");
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("digest must be a sha256 digest");
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be a semantic v* tag");
if (!/^docker\.io\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(reference)) throw new Error("reference must be an immutable Docker Hub digest reference");
if (fingerprint && !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error("image fingerprint must be a sha256 digest");
const manifest = { schemaVersion: 2, version, commit, opencodeVersion: "2.0.11", sandboxVersion: "0.12.9", platform: "linux/amd64", image: { reference, ...(fingerprint ? { fingerprint } : {}) }, buildImageDigest: digest };
if (args.get("--bundle")) {
  const bundle = args.get("--bundle");
  const bytes = await readFile(bundle);
  manifest.updater = { file: "app-bundle.json", sha256: createHash("sha256").update(bytes).digest("hex"), size: (await stat(bundle)).size };
}
await mkdir(dirname(args.get("--output")), { recursive: true });
await writeFile(args.get("--output"), JSON.stringify(manifest, null, 2) + "\n");
