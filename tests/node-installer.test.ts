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
    const stub = `import { appendFile, mkdir, writeFile } from "node:fs/promises"; import { dirname } from "node:path"; const a=process.argv; const i=a.indexOf("--config"); const c=a.indexOf("--control-url"); await mkdir(dirname(a[i+1]), {recursive:true}); if (a.includes("register")) await appendFile(process.env.NODE_INSTALL_ORDER_LOG, "register\\n"); await writeFile(a[i+1], JSON.stringify({nodeId:"node_smoke",nodeSecret:"secret_smoke",runnerToken:"runner_smoke",controlUrl:a[c+1]}));`;
    await writeFile(join(stage, "scripts/node-agent.mjs"), stub); await writeFile(join(stage, "scripts/node-update.mjs"), 'import { appendFile } from "node:fs/promises"; await appendFile(process.env.NODE_INSTALL_ORDER_LOG, "update\\n");\n'); await writeFile(join(stage, "runner/package.json"), '{"name":"runner","version":"0.0.0"}'); await writeFile(join(stage, "runner/package-lock.json"), '{"name":"runner","version":"0.0.0","lockfileVersion":3,"packages":{"":{"name":"runner","version":"0.0.0"}}}');
    await exec("tar", ["-czf", join(dir, "node-bundle.tar.gz"), "-C", stage, "."]);
    const archive = readFileSync(join(dir, "node-bundle.tar.gz")); const digest = createHash("sha256").update(archive).digest("hex");
    const manifest = JSON.stringify({ schemaVersion: 1, version: "v1.2.3", commit: "a".repeat(40), archive: { file: "node-bundle.tar.gz", size: archive.length, sha256: digest } });
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(bin, "npm"), "#!/bin/sh\nprintf '%s\\n' npm >> \"$NODE_INSTALL_ORDER_LOG\"\nexit 0\n"); await chmod(join(bin, "npm"), 0o755);
    await writeFile(join(bin, "npx"), "#!/bin/sh\nprintf '%s\\n' npx >> \"$NODE_INSTALL_ORDER_LOG\"\ncase \"$*\" in *playwright*install*chromium*) mkdir -p \"$PLAYWRIGHT_BROWSERS_PATH\"; : > \"$PLAYWRIGHT_BROWSERS_PATH/chromium-installed\";; esac\n"); await chmod(join(bin, "npx"), 0o755);
    // Keep platform detection deterministic. In particular, do not use a bare
    // `printf Linux\\n`: some shells pass the backslash through as `Linuxn`,
    // which selects neither service branch and can fall through to host tools.
    await writeFile(join(bin, "uname"), "#!/bin/sh\nprintf '%s\\n' \"${NODE_INSTALL_OS:-Linux}\"\n"); await chmod(join(bin, "uname"), 0o755);
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NODE_INSTALL_LOG\"\n"); await chmod(join(bin, "systemctl"), 0o755);
    // A Darwin branch must never be able to invoke the host launchctl. Make
    // accidental use fail closed and leave evidence for the assertion below.
    await writeFile(join(bin, "launchctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NODE_INSTALL_LAUNCHCTL_LOG\"\nexit 97\n"); await chmod(join(bin, "launchctl"), 0o755);
    let manifestPayload = manifest; let archivePayload = archive;
    const server = createServer((req, res) => { if (req.url?.endsWith("node-bundle-manifest.json")) { res.end(manifestPayload); return; } if (req.url?.endsWith("node-bundle.tar.gz")) { res.end(archivePayload); return; } res.statusCode = 404; res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
    const configDir = join(dir, "node-config"); const log = join(dir, "service.log"); const orderLog = join(dir, "order.log"); const launchctlLog = join(dir, "launchctl.log"); const token = "pairing-token-must-not-leak";
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OCBOT_RELEASE_BASE: `http://127.0.0.1:${address.port}`, OCBOT_NODE_HOME: join(dir, "runtime"), OCBOT_NODE_CONFIG_DIR: configDir, NODE_INSTALL_LOG: log, NODE_INSTALL_ORDER_LOG: orderLog, NODE_INSTALL_LAUNCHCTL_LOG: launchctlLog };
    try {
      archivePayload = Buffer.from("tampered bundle");
      await expect(exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", token, "--name", "Smoke laptop"], { env })).rejects.toThrow(/checksum or size verification failed/);
      archivePayload = archive;
      const result = await exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", token, "--name", "Smoke laptop"], { env });
      expect(result.stdout).not.toContain(token); expect(readFileSync(join(configDir, "node.json"), "utf8")).not.toContain(token); expect(readFileSync(join(home, ".config/systemd/user/opencode-bot-node.service"), "utf8")).not.toContain(token); expect(readFileSync(log, "utf8")).toContain("--user enable --now opencode-bot-node.service");
      expect(readFileSync(join(home, ".config/systemd/user/opencode-bot-node.service"), "utf8")).toContain("WantedBy=default.target");
      expect(() => readFileSync(launchctlLog, "utf8")).toThrow();
      expect(readFileSync(orderLog, "utf8")).toBe("register\nnpm\nnpx\n");
      expect(readFileSync(join(dir, "runtime", "browsers", "chromium-installed"), "utf8")).toBe("");

      // A retry for the same control server reuses the saved credentials and
      // must not redeem another pairing token. npm still runs after register
      // on the first install, proving registration precedes dependencies.
      await exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", "second-token-must-not-be-used", "--name", "Smoke laptop"], { env });
      expect(readFileSync(orderLog, "utf8")).toBe("register\nnpm\nnpx\nupdate\n");
      expect(readFileSync(join(configDir, "node.json"), "utf8")).not.toContain("second-token-must-not-be-used");

      // Exercise the macOS service failure path with the same isolated stubs.
      // It must return an error after bounded bootstrap retries.
      await rm(join(dir, "runtime"), { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true });
      const darwinEnv = { ...env, NODE_INSTALL_OS: "Darwin" };
      await expect(exec("bash", [join(root, "scripts/node-install.sh"), "--control-url", `http://127.0.0.1:${address.port}`, "--pairing-token", "third-token-must-not-be-used", "--name", "Smoke laptop"], { env: darwinEnv })).rejects.toThrow(/could not start the node service/);
      const launchctlCalls = readFileSync(launchctlLog, "utf8").trim().split("\n");
      expect(launchctlCalls.filter((line) => line.includes("bootstrap")).length).toBe(5);
      expect(launchctlCalls.some((line) => line.trim().startsWith("print "))).toBe(false);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("keeps the Windows installer registration before dependencies and installs private pinned Chromium", () => {
    const script = readFileSync(join(root, "scripts/node-install.ps1"), "utf8");
    expect(script.indexOf("register --control-url")).toBeGreaterThan(-1);
    expect(script.indexOf("register --control-url")).toBeLessThan(script.indexOf("ci --prefix"));
    expect(script).toContain("saved node connection");
    expect(script).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(script).toContain("--offline -- playwright install --no-shell chromium");
    expect(script).toContain("Private Chromium installation failed");
  });
});
