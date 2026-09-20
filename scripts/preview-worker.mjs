#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the container gateway stable while Vite hot-reloads the web client.
// Wrangler source reloads can invalidate the local container egress gateway.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, ".tmp", "stable-preview");
await mkdir(staging, { recursive: true });
const wrangler = path.join(
  root,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`Wrangler exited ${code}`)),
    );
  });
}
await execute([
  "deploy",
  "--dry-run",
  "--outdir",
  path.join(staging, "worker"),
]);
await cp(path.join(root, "apps/web/dist"), path.join(staging, "assets"), {
  recursive: true,
});
const config = JSON.parse(
  await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
);
config.main = path.join(staging, "worker", "index.js");
config.assets.directory = path.join(staging, "assets");
for (const computer of config.containers ?? []) {
  computer.image = path.resolve(root, computer.image);
  computer.image_build_context = root;
}
const filename = path.join(staging, "wrangler.json");
await writeFile(filename, JSON.stringify(config, null, 2));
console.log(
  "Starting stable preview backend. Web changes still refresh through Vite. Restart this command to load backend changes.",
);
const child = spawn(
  process.execPath,
  [
    wrangler,
    "dev",
    "--local",
    "--no-bundle",
    "--config",
    filename,
    "--persist-to",
    path.join(root, ".wrangler/state"),
    "--port",
    "8789",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
  process.exitCode = code ?? 0;
});
