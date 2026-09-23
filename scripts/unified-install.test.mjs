import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("unified installer keeps Cloudflare default and routes --boat without checkout", () => {
  const script = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  assert.match(script, /\[\[ \"\$wants_boat\" -eq 1 \]\]/);
  assert.match(script, /OCBOT_PROVIDER/);
  assert.match(script, /\[\[ \"\$arg\" == \"--boat\" \]\]/);
  assert.match(script, /skip_picker=0/);
  assert.match(script, /Cloudflare \(recommended;/);
  assert.match(script, /Boat \(preview; persistent VM/);
  assert.match(script, /read -r choice <\/dev\/tty/);
  assert.match(script, /scripts\/boat-install\.sh/);
  assert.match(script, /ensure_node/);
  assert.match(script, /ensure_cloudflare_auth/);
  assert.match(script, /--cloudflare/);
  assert.match(script, /--non-interactive/);
  assert.match(script, /provider flag conflicts/);
});

test("help is available before any network or prerequisite work", () => {
  const result = spawnSync("bash", ["install.sh", "--help"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--cloudflare\|--boat/);
  assert.match(result.stdout, /OCBOT_NONINTERACTIVE=1/);
});

test("conflicting provider selectors fail before downloading anything", () => {
  const result = spawnSync("bash", ["install.sh", "--boat", "--cloudflare"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /choose only one provider/);
});

test("--yes --boat bypasses the picker and forwards remaining flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbot-unified-test-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "args.log");
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\nout=""; prev=""; for arg in "$@"; do if [[ "$prev" == -o ]]; then out="$arg"; fi; prev="$arg"; done\ncat > "$out" <<'SCRIPT'\n#!/usr/bin/env bash\nif [[ "$#" -gt 0 ]]; then printf '%s\\n' "$@" > "$OCBOT_ARGS_LOG"; else : > "$OCBOT_ARGS_LOG"; fi\nSCRIPT\nchmod +x "$out"\n`);
  chmodSync(curl, 0o755);
  const result = spawnSync("bash", ["install.sh", "--yes", "--boat", "--open"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OCBOT_ARGS_LOG: log }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(log, "utf8").trim().split(/\n/), ["--yes", "--open"]);
  const empty = spawnSync("bash", ["install.sh", "--yes", "--boat"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OCBOT_ARGS_LOG: log }, encoding: "utf8", timeout: 10000 });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(readFileSync(log, "utf8").trim(), "--yes");
});

test("user-facing Boat docs use the unified entrypoint", () => {
  const docs = readFileSync(new URL("../docs/boat-setup.md", import.meta.url), "utf8");
  assert.match(docs, /main\/install\.sh/);
  assert.doesNotMatch(docs, /scripts\/boat-install\.sh/);
  assert.match(docs, /--boat/);
});
