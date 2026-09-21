import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { writeFile, mkdir, chmod, symlink, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("owned node installer", () => {
  it("accepts a pairing token only for one-shot registration and never puts it in a service", () => {
    const script = readFileSync(join(root, "scripts/node-install.sh"), "utf8");
    expect(script).toContain("--pairing-token");
    expect(script).toContain("--pairing-token \"$pairing_token\"");
    expect(script).not.toMatch(/ExecStart=.*pairing_token/);
    expect(script).not.toMatch(/StandardOutPath=.*config/);
  });

  it("writes a pinned node bundle manifest with an archive digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "node-manifest-"));
    tempDirs.push(dir);
    const archive = join(dir, "bundle.tar.gz");
    const output = join(dir, "manifest.json");
    await writeFile(archive, "bundle bytes");
    await exec(process.execPath, [join(root, "scripts/release/write-node-manifest.mjs"), "--output", output, "--version", "v1.2.3", "--commit", "a".repeat(40), "--archive", archive]);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, version: "v1.2.3", archive: { file: "node-bundle.tar.gz", size: 12, sha256: createHash("sha256").update("bundle bytes").digest("hex") } });
  });

  it("installs a release bundle end to end without a checkout or token in service state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "node-installer-smoke-"));
    tempDirs.push(dir);
    const stage = join(dir, "stage"); const bin = join(dir, "bin"); const home = join(dir, "home");
    await mkdir(join(stage, "scripts"), { recursive: true }); await mkdir(join(stage, "runner"), { recursive: true }); await mkdir(bin); await mkdir(home);
    const stub = `import { mkdir, writeFile } from "node:fs/promises"; import { dirname } from "node:path"; const a=process.argv; const i=a.indexOf("--config"); await mkdir(dirname(a[i+1]), {recursive:true}); await writeFile(a[i+1], JSON.stringify({nodeId:"node_smoke",nodeSecret:"secret_smoke",runnerToken:"runner_smoke"}));`;
    await writeFile(join(stage, "scripts/node-agent.mjs"), stub); await writeFile(join(stage, "runner/package.json"), '{"name":"runner","version":"0.0.0"}'); await writeFile(join(stage, "runner/package-lock.json"), '{"name":"runner","version":"0.0.0","lockfileVersion":3,"packages":{"":{"name":"runner","version":"0.0.0"}}}');
    await exec("tar", ["-czf", join(dir, "node-bundle.tar.gz"), "-C", stage, "."]);
    const archive = readFileSync(join(dir, "node-bundle.tar.gz")); const digest = createHash("sha256").update(archive).digest("hex");
    const manifest = JSON.stringify({ schemaVersion: 1, version: "v1.2.3", commit: "a".repeat(40), archive: { file: "node-bundle.tar.gz", size: archive.length, sha256: digest } });
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "uname"), "#!/bin/sh\nprintf Linux\\n"); await chmod(join(bin, "uname"), 0o755);
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NODE_INSTALL_LOG\"\n"); await chmod(join(bin, "systemctl"), 0o755);
    let manifestPayload = manifest; let archivePayload = archive;
    const server = createServer((req, res) => { if (req.url?.endsWith("node-bundle-manifest.json")) { res.end(manifestPayload); return; } if (req.url?.endsWith("node-bundle.tar.gz")) { res.end(archivePayload); return; } res.statusCode = 404; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
    const configDir = join(dir, "node-config"); const log = join(dir, "service.log"); const token = "pairing-token-must-not-leak";
    try {
      archivePayload = Buffer.from("tampered bundle");
      await expect(exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", token, "--name", "Smoke laptop"], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OCBOT_RELEASE_BASE: `http://127.0.0.1:${address.port}`, OCBOT_NODE_HOME: join(dir, "runtime"), OCBOT_NODE_CONFIG_DIR: configDir, NODE_INSTALL_LOG: log } })).rejects.toThrow(/checksum or size verification failed/);
      archivePayload = archive;
      const result = await exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", token, "--name", "Smoke laptop"], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OCBOT_RELEASE_BASE: `http://127.0.0.1:${address.port}`, OCBOT_NODE_HOME: join(dir, "runtime"), OCBOT_NODE_CONFIG_DIR: configDir, NODE_INSTALL_LOG: log } });
      expect(result.stdout).not.toContain(token); expect(readFileSync(join(configDir, "node.json"), "utf8")).not.toContain(token); expect(readFileSync(join(home, ".config/systemd/user/opencode-bot-node.service"), "utf8")).not.toContain(token); expect(readFileSync(log, "utf8")).toContain("--user enable --now opencode-bot-node.service");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
