import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--output", "--version", "--commit", "--digest", "--archive", "--archive-sha256"]) if (!args.get(key)) throw new Error(key + " is required");
const commit = args.get("--commit"), digest = args.get("--digest"), version = args.get("--version");
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full 40 character SHA");
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("digest must be a sha256 digest");
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be a semantic v* tag");
if (!/^[0-9a-f]{64}$/.test(args.get("--archive-sha256"))) throw new Error("archive SHA-256 is invalid");
const archive = args.get("--archive"), archiveStat = await stat(archive), output = args.get("--output");
const manifest = {
  schemaVersion: 1, version, commit, opencodeVersion: "2.0.11", sandboxVersion: "0.12.9",
  platform: "linux/amd64", buildImageDigest: digest,
  imageArchive: { file: archive.split("/").pop(), sha256: args.get("--archive-sha256"), size: archiveStat.size },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
