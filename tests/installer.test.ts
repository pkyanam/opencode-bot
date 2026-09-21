import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const installer = resolve(root, "install.sh");

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-installer-test-"));
  const bin = join(dir, "bin");
  const log = join(dir, "commands.log");
  const home = join(dir, "home");
  const install = join(dir, "checkout");
  const runtime = join(dir, "runtime");
  mkdirSync(bin);
  writeFileSync(log, "");
  executable(join(bin, "node"), `exec '${process.execPath}' "$@"`);
  executable(join(bin, "npm"), `printf 'npm %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"`);
  executable(join(bin, "curl"), `url="$2"; out="$4"; case "$url" in *release-manifest.json) if [ "\${OCBOT_TEST_MANIFEST_SCHEMA:-1}" = 2 ]; then printf '{"schemaVersion":2,"version":"v0.1.1","commit":"1111111111111111111111111111111111111111","image":{"reference":"docker.io/preethamk/opencode-bot@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\\n' > "$out"; else printf '{"schemaVersion":1,"version":"v0.1.1","commit":"1111111111111111111111111111111111111111"}\\n' > "$out"; fi ;; *) printf 'node archive' > "$out" ;; esac`);
  executable(join(bin, "npx"), `
    printf 'npx %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"
    case "$*" in *--json) printf '[{"id":"acct","name":"Test Account"}]' ;; esac
  `);
  executable(join(bin, "open"), `printf 'open %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"`);
  executable(join(bin, "git"), `
    printf 'git %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"
    if [ "\${1-}" = "clone" ]; then
      mkdir -p "$7/.git"
      printf '#!/bin/sh\\nprintf "setup apply --apply --install-missing\\n" >> "\${OCBOT_TEST_LOG}"\\n' > "$7/setup.sh"
      chmod 755 "$7/setup.sh"
    elif [ "\${1-}" = "-C" ] && [ "\${3-}" = "remote" ]; then
      printf '%s\\n' "\${OCBOT_REPO_URL:-https://github.com/pkyanam/opencode-bot.git}"
    elif [ "\${1-}" = "-C" ] && [ "\${3-}" = "status" ]; then :
    elif [ "\${1-}" = "-C" ] && [ "\${3-}" = "rev-parse" ]; then printf '1111111111111111111111111111111111111111\\n'
    fi
  `);
  return { dir, bin, log, home, install, runtime };
}

function runScript(f: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  return execFileSync("bash", ["-s", "--", "--yes"], {
    cwd: f.dir,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, TMPDIR: f.dir,
      OCBOT_INSTALL_DIR: f.install, OCBOT_NODE_ROOT: f.runtime,
      OCBOT_REPO_URL: "https://github.com/pkyanam/opencode-bot.git", OCBOT_TEST_LOG: f.log, ...extraEnv },
    input: readFileSync(installer), encoding: "utf8",
  });
}

describe("public installer", () => {
  it("clones a fresh installation from piped stdin", () => {
    const f=fixture();
    expect(runScript(f)).toContain(`installed successfully at ${f.install}`);
    expect(readFileSync(f.log,"utf8")).toContain("git clone --branch v0.1.1 --depth 1");
    expect(readFileSync(f.log,"utf8")).toContain("setup apply --apply --install-missing");
  });

  it("accepts a schema 2 manifest with a pinned Docker Hub digest", () => {
    const f = fixture();
    expect(runScript(f, { OCBOT_TEST_MANIFEST_SCHEMA: "2" })).toContain(`installed successfully at ${f.install}`);
    expect(readFileSync(join(f.install, ".opencode-bot/release-manifest.json"), "utf8")).toContain("docker.io/preethamk/opencode-bot@sha256:");
  });

  it("resumes installation and opens a private owner handoff", () => {
    const f = fixture();
    // A prior successful deploy provides a private browser handoff.
    mkdirSync(join(f.install, ".git"), {recursive:true});
    mkdirSync(join(f.install, ".opencode-bot"), {recursive:true});
    executable(join(f.install, "setup.sh"), `printf 'setup apply --apply --install-missing\\n' >> "$OCBOT_TEST_LOG"`);
    const token="z".repeat(43);
    writeFileSync(join(f.install,".opencode-bot/deployment-state.json"), JSON.stringify({deploymentUrl:"https://ocbot-personal.example.workers.dev"}));
    writeFileSync(join(f.install,".opencode-bot/secrets.json"), JSON.stringify({APP_TOKEN:token}));
    const output = runScript(f);
    const calls = readFileSync(f.log, "utf8");
    expect(output).toContain(`installed successfully at ${f.install}`);
    expect(calls).toContain("npm ci");
    expect(calls).not.toContain("docker info");
    expect(calls).toContain("npx --no-install wrangler whoami");
    expect(calls).toContain("setup apply --apply --install-missing");
    expect(existsSync(join(f.install, "setup.sh"))).toBe(true);
    const handoff=join(f.install,".opencode-bot/open.html");
    expect(readFileSync(handoff,"utf8")).toContain("#connect="+token);
    expect(statSync(handoff).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(token);
  });

  it("refuses an existing checkout with local changes", () => {
    const f = fixture();
    mkdirSync(join(f.install, ".git"), { recursive: true });
    executable(join(f.bin, "git"), `
      printf 'git %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"
      if [ "\${3-}" = "remote" ]; then printf '%s\\n' "$OCBOT_REPO_URL"; fi
      if [ "\${3-}" = "status" ]; then printf ' M user-file\\n'; fi
    `);
    expect(() => runScript(f)).toThrow(/has local changes/);
    expect(readFileSync(f.log, "utf8")).not.toContain("npm ci");
  });

  it("refuses a checkout belonging to another repository", () => {
    const f = fixture();
    mkdirSync(join(f.install, ".git"), { recursive: true });
    executable(join(f.bin, "git"), `
      printf 'git %s\\n' "$*" >> "\${OCBOT_TEST_LOG}"
      if [ "\${3-}" = "remote" ]; then printf 'https://example.invalid/other.git\\n'; fi
    `);
    expect(() => runScript(f)).toThrow(/different repository/);
  });

  it("rejects a Node archive whose checksum does not match the manifest", () => {
    const f = fixture();
    const bootstrapBin = join(f.dir, "bootstrap-bin");
    mkdirSync(bootstrapBin);
    executable(join(bootstrapBin, "node"), "printf '18\\n'");
    executable(join(bootstrapBin, "curl"), `
      url="$2"; out="$4"
      case "$url" in *SHASUMS256.txt) printf 'deadbeef  node-v24.14.0-linux-x64.tar.xz\\ndeadbeef  node-v24.14.0-linux-arm64.tar.xz\\ndeadbeef  node-v24.14.0-darwin-x64.tar.gz\\ndeadbeef  node-v24.14.0-darwin-arm64.tar.gz\\n' > "$out";; *release-manifest.json) printf '{"schemaVersion":1,"version":"v0.1.1","commit":"1111111111111111111111111111111111111111"}\\n' > "$out";; *) printf 'not-a-node-archive' > "$out";; esac
    `);
    expect(() => runScript(f, { PATH: `${bootstrapBin}:/usr/bin:/bin` })).toThrow(/checksum verification failed/);
    expect(existsSync(join(f.install, ".git"))).toBe(false);
    expect(existsSync(f.runtime)).toBe(false);
  });
});
