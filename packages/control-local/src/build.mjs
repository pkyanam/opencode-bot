import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(here, "../dist/control-local.js"),
  packages: "bundle",
  alias: { "@cloudflare/sandbox": resolve(here, "unavailable-sandbox.ts") },
  // yaml contains a Node-only dynamic require; leave it to Node's ESM loader.
  external: ["node:*", "yaml"],
  sourcemap: true,
});
