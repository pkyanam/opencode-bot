import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { install, status, uninstall, verifyBundle, validateBoatOptions, readMemoryProviderFile, safeCommandFailure, readCompletionMarker, MAX_BOAT_EXEC_TIMEOUT_SECONDS } from "./setup/boat.mjs";

function bundleFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocbot-boat-test-"));
  const file = join(dir, "release.tar.gz"); writeFileSync(file, "verified test archive\n");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { dir, file, sha256 };
}

test("Boat setup entrypoint runs through symlinks, spaces, and doubled slashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbot boat launcher "));
  const link = join(dir, "boat setup.mjs");
  symlinkSync(resolve("scripts/setup/boat.mjs"), link);
  const stateDir = join(dir, "isolated state");
  for (const executable of [link, `${dir}//boat setup.mjs`]) {
    const result = spawnSync(process.execPath, [executable, "status", "--state-dir", stateDir], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { installed: false, statePath: resolve(stateDir, "state.json") });
  }
});

function detachedMock(name, args) {
  if (name !== "boat" || args[0] !== "exec") return undefined;
  if (args.includes("--detach")) return { status: 0, stdout: '{"pid":777}', stderr: "" };
  if (args.includes("--status")) return { status: 0, stdout: args[1] === "bx_failed" ? '{"pid":777,"status":"exited","running":false,"exitCode":17,"known":true}' : '{"pid":777,"status":"exited","running":false,"exitCode":0,"known":true}', stderr: "" };
  return undefined;
}

test("Boat bundle verification requires the exact digest", () => {
  const fixture = bundleFixture();
  assert.equal(verifyBundle(fixture.file, fixture.sha256).sha256, fixture.sha256);
  assert.throws(() => verifyBundle(fixture.file, "0".repeat(64)), /sha256 mismatch/);
  assert.throws(() => verifyBundle(undefined, fixture.sha256), /release bundle is required/);
});

test("Boat options reject invalid type, port, ttl, and host access before commands run", () => {
  assert.deepEqual(validateBoatOptions({ type: "small", port: "8080", ttl: "60" }), { type: "small", port: 8080, ttl: 60, hostAccess: "public" });
  assert.throws(() => validateBoatOptions({ type: "bogus" }), /type must be one of/);
  assert.throws(() => validateBoatOptions({ port: "NaN" }), /port must be an integer/);
  assert.throws(() => validateBoatOptions({ port: 65536 }), /port must be an integer/);
  assert.throws(() => validateBoatOptions({ ttl: 0 }), /ttl must be an integer/);
  assert.throws(() => validateBoatOptions({ ttl: "1.5" }), /ttl must be an integer/);
  assert.throws(() => validateBoatOptions({ hostAccess: "internal" }), /host access/);
});

test("install validates options before touching the bundle or Boat CLI", () => {
  const calls = [];
  assert.throws(() => install({ run: (...args) => calls.push(args), port: "NaN" }), /port must be an integer/);
  assert.deepEqual(calls, []);
});

test("Boat exec stays within the documented CLI timeout ceiling and errors stay sanitized", () => {
  assert.equal(MAX_BOAT_EXEC_TIMEOUT_SECONDS, 600);
  assert.match(safeCommandFailure("boat", { status: 2, stderr: "unknown option --timeout 1800" }), /rejected an option/);
  assert.match(safeCommandFailure("boat", { status: 1, stderr: "401 unauthorized secret-token" }), /authentication failed/);
  assert.doesNotMatch(safeCommandFailure("boat", { status: 1, stderr: "401 unauthorized secret-token" }), /secret-token/);
  assert.doesNotMatch(safeCommandFailure("boat", { status: 1, stderr: '{"timedOut":false,"exitCode":1}' }), /timed out/);
});

test("standalone shell defaults to trusted GitHub latest manifest discovery", () => {
  const script = readFileSync(new URL("./boat-install.sh", import.meta.url), "utf8");
  assert.match(script, /releases\/latest\/download\/boat-bundle-manifest\.json/);
  assert.match(script, /m\.archive\?\.file!=="boat-bundle\.tar\.gz"/);
  assert.match(script, /m\.archive\.sha256/);
  assert.match(script, /installer-ui\.mjs/);
  assert.match(script, /--status\) node_command=status/);
  assert.match(script, /--doctor\) node_command=doctor/);
  assert.match(script, /node_home=.*opencode-bot\/tools\/boat-node/);
  assert.match(script, /SHASUMS256\.txt/);
  assert.match(script, /github\.com\/pkyanam\/opencode-bot\/releases/);
});

test("Boat setup health checks use syntactically complete stdin handlers", () => {
  const setup = readFileSync(new URL("../boat/setup.sh", import.meta.url), "utf8");
  assert.equal((setup.match(/process\.stdin\.on\("end", \(\) => \{/g) || []).length, 3);
  assert.match(setup, /process\.exit\(1\); \}\s*\}\);/);
});

test("Boat bootstrap marker EXIT trap coexists with release rollback ERR trap", () => {
  const setup = readFileSync(new URL("../boat/setup.sh", import.meta.url), "utf8");
  assert.match(setup, /trap finish_bootstrap_marker EXIT/);
  assert.match(setup, /trap rollback ERR/);
  assert.match(setup, /trap - ERR;[^\n]*printf 'Boat app ready/);
  assert.match(setup, /write_bootstrap_marker (terminal 0|failed \"\$code\")/);
});

test("incomplete bootstrap markers never authorize cleanup", () => {
  const run = (_name, _args) => ({ status: 0, stdout: '{"stdout":"{\\"status\\":\\"running\\",\\"exitCode\\":null}\\n"}', stderr: "" });
  assert.equal(readCompletionMarker(run, "bx_marker", "/var/lib/opencode-bot/bootstrap.json"), undefined);
  const done = (_name, _args) => ({ status: 0, stdout: '{"stdout":"{\\"status\\":\\"failed\\",\\"exitCode\\":1}\\n"}', stderr: "" });
  assert.equal(readCompletionMarker(done, "bx_marker", "/var/lib/opencode-bot/bootstrap.json").exitCode, 1);
});

test("memory provider file validates safe URL and required fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbot-memory-test-"));
  const file = join(dir, "provider.json");
  writeFileSync(file, JSON.stringify({ llmBaseUrl: "http://127.0.0.1:8080/v1", llmApiKey: "secret", llmModel: "local-model" }));
  assert.deepEqual(readMemoryProviderFile(file), { llmBaseUrl: "http://127.0.0.1:8080/v1", llmApiKey: "secret", llmModel: "local-model" });
  writeFileSync(file, JSON.stringify({ llmBaseUrl: "http://llm.example", llmApiKey: "secret", llmModel: "m" }));
  assert.throws(() => readMemoryProviderFile(file), /HTTPS/);
});

test("Boat install uses no-env, public hosting by default, and writes redacted ownership state", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = []; const progress = [];
  const run = (name, args) => {
    const detached = detachedMock(name, args); if (detached) return detached;
    calls.push([name, args]);
    if (name !== "boat") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_test123","state":"ready"}\n', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"sandboxId":"bx_test123","port":8789,"url":"https://app-8789.on.boat.dev","access":"public"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256, appToken: "app-secret-test", progress: message => progress.push(message) });
  assert.equal(result.id, "bx_test123");
  assert.equal(result.url, "https://app-8789.on.boat.dev");
  const newCall = calls.find(([name, args]) => name === "boat" && args[0] === "new");
  assert.ok(newCall?.[1].includes("--no-env"));
  const hostCall = calls.find(([name, args]) => name === "boat" && args[0] === "host");
  assert.ok(hostCall?.[1].includes("--public"));
  const stateText = readFileSync(join(stateDir, "state.json"), "utf8");
  assert.doesNotMatch(stateText, /secret-token|app-secret-test/);
  assert.equal(statSync(join(stateDir, "secrets.json")).mode & 0o777, 0o600);
  const execTimeouts = calls.filter(([name, args]) => name === "boat" && args[0] === "exec").map(([, args]) => Number(args[args.indexOf("--timeout") + 1]));
  assert.ok(execTimeouts.length > 0 && execTimeouts.every(value => value <= MAX_BOAT_EXEC_TIMEOUT_SECONDS));
  assert.deepEqual(progress.slice(0, 5), ["preparing runtime", "uploading release", "installing app", "hosting app", "checking authenticated health"]);
  assert.match(progress[5], /Owner connection saved to .*open.html/);
  assert.equal(statSync(join(stateDir, "open.html")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(stateDir, "open.html"), "utf8"), /#connect=app-secret-test/);
});

test("private Boat hosting is opt-in", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    const detached = detachedMock(name, args); if (detached) return detached;
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_private"}', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"url":"https://private.on.boat.dev?_token=t","access":"private"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256, hostAccess: "private" });
  const hostCall = calls.find(([name, args]) => name === "boat" && args[0] === "host");
  assert.ok(hostCall?.[1].includes("--private")); assert.ok(!hostCall?.[1].includes("--public"));
  assert.doesNotMatch(readFileSync(join(stateDir, "state.json"), "utf8"), /\?_token=t/);
});

test("new Boat sandbox receives the selected shape and persists it", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    const detached = detachedMock(name, args); if (detached) return detached;
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_large","type":"large"}', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"url":"https://large.on.boat.dev","access":"public"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256, type: "large" });
  const created = calls.find(([name, args]) => name === "boat" && args[0] === "new");
  assert.ok(created?.[1].includes("--type") && created?.[1].includes("large"));
  assert.equal(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).type, "large");
});

test("rerunning an existing sandbox reuses its recorded shape", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ schemaVersion: 1, provider: "boat", sandboxId: "bx_existing", type: "large", journal: [] }));
  const run = (name, args) => {
    calls.push([name, args]);
    const detached = detachedMock(name, args); if (detached) return detached;
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "info") return { status: 0, stdout: '{"id":"bx_existing","state":"ready","type":"large"}', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"url":"https://existing.on.boat.dev","access":"public"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256 });
  assert.equal(calls.some(([name, args]) => name === "boat" && args[0] === "new"), false);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).type, "large");
});

test("browser handoff carries the app token in a fragment only", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  const run = (name, args) => {
    const detached = detachedMock(name, args); if (detached) return detached;
    calls.push([name, args]);
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_open"}', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"url":"https://open.on.boat.dev","access":"public"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256, appToken: "browser-app-token", open: true });
  const opened = calls.find(([name]) => ["open", "xdg-open", "cmd"].includes(name))?.[1]?.at(-1);
  assert.equal(opened, "https://open.on.boat.dev/#connect=browser-app-token");
});

test("setup failure preserves a provisioning journal and never hosts or claims installation", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    const detached = detachedMock(name, args); if (detached) return detached;
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_failed"}', stderr: "" };
    if (args[0] === "exec" && args.some(value => String(value).includes("APP_BUNDLE_DIR=") && String(value).includes("/boat/setup.sh"))) return { status: 0, stdout: '{"exitCode":17}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.throws(() => install({ run, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256, appToken: "stable-token" }), /exit 17/);
  assert.equal(calls.some(([, args]) => args[0] === "host"), false);
  const remoteCommands = calls.filter(([, args]) => args[0] === "exec").map(([, args]) => args.at(-1)).join(" ");
  assert.match(remoteCommands, /opencode-bot-stage-bx_failed/);
  assert.match(remoteCommands, /APP_BUNDLE_DIR=/);
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  assert.equal(state.installationState, "provisioning"); assert.equal(state.host, undefined);
  const secrets = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
  assert.equal(secrets.appToken, "stable-token");
});

test("status and uninstall are scoped to the recorded sandbox", () => {
  const fixture = bundleFixture(); const stateDir = join(fixture.dir, "state"); const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    if (args[0] === "info") return { status: 0, stdout: '{"id":"bx_owned","state":"ready"}', stderr: "" };
    if (args[0] === "delete") return { status: 0, stdout: '{"ok":true}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  writeFileSync(join(fixture.dir, "seed"), "x");
  install({ run: (name, args) => {
    const detached = detachedMock(name, args); if (detached) return detached;
    if (args[0] === "status") return { status: 0, stdout: '{"status":"ok"}', stderr: "" };
    if (args[0] === "new") return { status: 0, stdout: '{"event":"ready","id":"bx_owned"}', stderr: "" };
    if (args[0] === "host") return { status: 0, stdout: '{"url":"https://x.on.boat.dev","access":"private"}', stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }, stateDir, bundle: fixture.file, bundleSha256: fixture.sha256 });
  assert.equal(status({ run, stateDir }).sandboxId, "bx_owned");
  assert.throws(() => uninstall({ run, stateDir }), /pass --yes/);
  assert.equal(uninstall({ run, stateDir, yes: true }).removed, true);
  assert.deepEqual(calls.find(([name]) => name === "boat" && calls.some(([, args]) => args[0] === "delete"))?.[0], "boat");
});
