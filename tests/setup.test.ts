import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "node:fs";
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

  it("runs a resumable apply with fake local/cloud commands", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "ocbot-setup-"));
    mkdirSync(resolve(fixture, "scripts/setup"), { recursive: true });
    mkdirSync(resolve(fixture, "infra"), { recursive: true });
    cpSync(resolve(root, "scripts/setup/botctl.mjs"), resolve(fixture, "scripts/setup/botctl.mjs"));
    cpSync(resolve(root, "scripts/setup.mjs"), resolve(fixture, "scripts/setup.mjs"));
    cpSync(resolve(root, "wrangler.jsonc"), resolve(fixture, "wrangler.jsonc"));
    writeFileSync(resolve(fixture, "infra/deployment.json"), JSON.stringify({ name: "ocbot-personal", bucketName: "ocbot-personal-artifacts", opencodeVersion: "2.0.11" }));
    writeFileSync(resolve(fixture, "package.json"), '{"name":"fixture"}');
    const bin = resolve(fixture, "bin"); mkdirSync(bin);
    const log = resolve(fixture, "commands.log");
    const fake = (name: string, body: string) => writeFileSync(resolve(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n` , { mode: 0o755 });
    fake("git", "exit 0"); fake("docker", "[ \"$1\" = info ] && echo 29.0 || true");
    fake("npm", "if [ \"$1\" = run ]; then mkdir -p apps/web/dist; fi");
    fake("npx", "case \"$*\" in *whoami*) echo 'You are logged in' ;; *'bucket list'*) echo 'name' ;; *) exit 0 ;; esac");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    execFileSync(process.execPath, [resolve(fixture, "scripts/setup.mjs"), "apply", "--apply", "--install-missing"], { cwd: fixture, env, encoding: "utf8" });
    const secrets = JSON.parse(readFileSync(resolve(fixture, ".opencode-bot/secrets.json"), "utf8"));
    expect(secrets.APP_TOKEN).toHaveLength(43);
    expect(readFileSync(log, "utf8")).toMatch(/npm ci/);
    expect(readFileSync(log, "utf8")).toMatch(/bucket create/);
  });
});
