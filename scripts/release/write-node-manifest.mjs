import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ["--output", "--version", "--commit", "--archive"]) if (!args.get(key)) throw new Error(`${key} is required`);
const archive = args.get("--archive");
const bytes = await readFile(archive);
const manifest = {
  schemaVersion: 1,
  version: args.get("--version"),
  commit: args.get("--commit"),
  nodeVersion: "24.14.0",
  archive: { file: "node-bundle.tar.gz", size: (await stat(archive)).size, sha256: createHash("sha256").update(bytes).digest("hex") },
};
if (!/^v\d+\.\d+\.\d+$/.test(manifest.version) || !/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("invalid release version or commit");
await mkdir(dirname(args.get("--output")), { recursive: true });
await writeFile(args.get("--output"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
