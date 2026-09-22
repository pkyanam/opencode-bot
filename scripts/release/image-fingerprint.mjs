#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const execFileAsync = promisify(execFile);

async function trackedInputs(base) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "runner", "skills", "docs", "README.md", "SECURITY.md", "packages/runtime-opencode2", "packages/browser", "images/computer/Dockerfile", ".dockerignore"], { cwd: base, encoding: "utf8" });
  return stdout.split("\0").filter(Boolean);
}

export async function imageFingerprint(base = root, inputPaths) {
  const paths = (inputPaths ?? await trackedInputs(base)).map(path => join(base, path));
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    hash.update(relative(base, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await imageFingerprint());
}
