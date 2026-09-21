import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, realpathSync, statSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "scripts/setup.mjs");

describe("setup planner", () => {
  it("prints a redacted plan without creating deployment state", () => {
    const state = resolve(root, ".opencode-bot");
    const before = existsSync(state) ? statSync(state).mtimeMs : undefined;
    const output = execFileSync(process.execPath, [cli, "plan"], { cwd: root, encoding: "utf8" });
    expect(output).toContain('"opencodeVersion": "2.0.11"');
    expect(output).toContain('"APP_TOKEN"');
    expect(output).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    if (before !== undefined) expect(statSync(state).mtimeMs).toBe(before);
    else expect(existsSync(state)).toBe(false);
  });

  it("requires an explicit apply flag", () => {
    expect(() => execFileSync(process.execPath, [cli, "apply"], { cwd: root, encoding: "utf8", stdio: "pipe" })).toThrow();
  });

  it.each([1, 2])("runs schema %s apply without Docker", (schemaVersion) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "ocbot-setup-"));
    mkdirSync(resolve(fixture, "scripts/setup"), { recursive: true });
    mkdirSync(resolve(fixture, "infra"), { recursive: true });
    cpSync(resolve(root, "scripts/setup/botctl.mjs"), resolve(fixture, "scripts/setup/botctl.mjs"));
    cpSync(resolve(root, "scripts/setup/uninstall.mjs"), resolve(fixture, "scripts/setup/uninstall.mjs"));
    cpSync(resolve(root, "scripts/setup/release.mjs"), resolve(fixture, "scripts/setup/release.mjs"));
    cpSync(resolve(root, "scripts/setup.mjs"), resolve(fixture, "scripts/setup.mjs"));
    cpSync(resolve(root, "wrangler.jsonc"), resolve(fixture, "wrangler.jsonc"));
    writeFileSync(resolve(fixture, "infra/deployment.json"), JSON.stringify({ name: "ocbot-personal", bucketName: "ocbot-personal-artifacts", accountId: "0123456789abcdef0123456789abcdef", opencodeVersion: "2.0.11" }));
    writeFileSync(resolve(fixture, "package.json"), '{"name":"fixture"}');
    const bin = resolve(fixture, "bin"); mkdirSync(bin);
    mkdirSync(resolve(fixture, ".opencode-bot"));
    const archive = gzipSync(Buffer.from("test computer image archive"));
    if (schemaVersion === 1) writeFileSync(resolve(fixture, ".opencode-bot/computer-image.tar.gz"), archive);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(resolve(fixture, ".opencode-bot/release-manifest.json"), JSON.stringify({ schemaVersion, image: { reference: "docker.io/preethamk/opencode-bot@sha256:" + "a".repeat(64) }, version: "v0.1.1", commit, platform: "linux/amd64", opencodeVersion: "2.0.11", sandboxVersion: "0.12.9", imageArchive: { file: "computer-image.tar.gz", sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length } }));
    mkdirSync(resolve(fixture, ".opencode-bot/bin"));
    writeFileSync(resolve(fixture, ".opencode-bot/bin/crane"), "#!/bin/sh\ncase \"$1\" in digest) echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;; auth|push) exit 0 ;; esac\n", { mode: 0o700 });
    if (schemaVersion === 2) writeFileSync(resolve(fixture, ".opencode-bot/bin/crane"), "#!/bin/sh\nexit 99\n", {mode:0o700});
    const log = resolve(fixture, "commands.log");
    const fake = (name: string, body: string) => writeFileSync(resolve(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n` , { mode: 0o755 });
    fake("git", `if [ "$1" = rev-parse ]; then echo '${commit}'; fi`);
    fake("npm", "if [ \"$1\" = run ]; then mkdir -p apps/web/dist; fi");
    fake("curl", `cp '${resolve(fixture, ".opencode-bot/computer-image.tar.gz")}' "$8"`);
    fake("tar", "mkdir -p \"$5\"; printf '#!/bin/sh\\ncase \"$1\" in digest) echo sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;; auth|push) exit 0 ;; esac\\n' > \"$5/crane\"; chmod +x \"$5/crane\"");
    fake("npx", "case \"$*\" in *whoami*) echo 'You are logged in' ;; *credentials*) echo '{\"username\":\"test\",\"password\":\"secret\",\"account_id\":\"0123456789abcdef0123456789abcdef\",\"registry_host\":\"registry.cloudflare.com\"}' ;; *'bucket list'*) echo 'name' ;; *'deployments list'*) exit 0 ;; *deploy*) echo 'https://ocbot-personal.example.workers.dev' ;; *) exit 0 ;; esac");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OCBOT_SKIP_HEALTH: "1" };
    execFileSync(process.execPath, [resolve(fixture, "scripts/setup.mjs"), "apply", "--apply", "--install-missing"], { cwd: fixture, env, encoding: "utf8" });
    const secrets = JSON.parse(readFileSync(resolve(fixture, ".opencode-bot/secrets.json"), "utf8"));
    expect(secrets.APP_TOKEN).toHaveLength(43);
    expect(readFileSync(log, "utf8")).toMatch(/npm ci/);
    expect(readFileSync(log, "utf8")).toMatch(/bucket create/);
    expect(readFileSync(log, "utf8")).not.toMatch(/docker/);
    const generated = JSON.parse(readFileSync(resolve(fixture, ".opencode-bot/wrangler.deploy.json"), "utf8"));
    expect(generated.main).toBe(resolve(realpathSync(fixture), "apps/control-worker/src/index.ts"));
    expect(generated.assets.directory).toBe(resolve(realpathSync(fixture), "apps/web/dist"));
    expect(generated.main).toMatch(/apps\/control-worker\/src\/index\.ts$/);
    expect(generated.assets.directory).toMatch(/apps\/web\/dist$/);
    if (schemaVersion === 1) expect(generated.containers[0].image).toMatch(/^registry\.cloudflare\.com\/[^@]+@sha256:[0-9a-f]{64}$/);
    else {
      expect(generated.containers[0].image).toBe("docker.io/preethamk/opencode-bot@sha256:" + "a".repeat(64));
      expect(readFileSync(log, "utf8")).not.toMatch(/credentials|curl|tar /);
    }
    expect(generated.containers[0].image).not.toMatch(/:v0\.1\.1-/);
    expect(readdirSync(resolve(fixture, ".opencode-bot")).some(file => file.startsWith("docker-config-"))).toBe(false);
  });
});
