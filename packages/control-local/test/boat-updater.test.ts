import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BoatUpdater, verifyBundle } from "../src/boat-updater";

describe("Boat release verification", () => {
  it("accepts an exact manifest/archive pair and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-updater-"));
    const bytes = Buffer.from("signed release payload");
    await writeFile(join(root, "boat-bundle.tar.gz"), bytes);
    const manifest = {
      version: "v1.2.3",
      commit: "a".repeat(40),
      archive: {
        file: "boat-bundle.tar.gz",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    const path = join(root, "boat-bundle-manifest.json");
    await writeFile(path, JSON.stringify(manifest));
    await expect(verifyBundle(path)).resolves.toMatchObject({
      version: "v1.2.3",
    });
    await writeFile(join(root, "boat-bundle.tar.gz"), Buffer.from("tampered"));
    await expect(verifyBundle(path)).rejects.toThrow(/size|checksum/);
  });
});

describe("Boat updater control boundary", () => {
  it("reports the first available release and queues only a strict root request", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-updater-status-"));
    const current = join(root, "current"); await (await import("node:fs/promises")).mkdir(current);
    await writeFile(join(current, "boat-release.json"), JSON.stringify({ version: "v1.0.0", commit: "a".repeat(40) }));
    const statePath = join(root, "state.json"); const requestPath = join(root, "request.json"); let starts = 0;
    const updater = new BoatUpdater({ statePath, currentRelease: current, requestPath, fetcher: async () => new Response(JSON.stringify({ version: "v1.1.0", commit: "b".repeat(40), archive: { file: "boat-bundle.tar.gz", sha256: "c".repeat(64), size: 12 } })), privilegedStart: async () => { starts++; } });
    await expect(updater.status()).resolves.toMatchObject({ currentVersion: "v1.0.0", latestVersion: "v1.1.0", available: true });
    await expect(updater.start("v1.1.0")).resolves.toMatchObject({ accepted: true });
    expect(starts).toBe(1);
    expect(JSON.parse(await readFile(requestPath, "utf8"))).toMatchObject({ version: "v1.1.0" });
    expect(Object.keys(JSON.parse(await readFile(requestPath, "utf8"))).sort()).toEqual(["id", "version"]);
  });

  it("persists a failed queued job when the fixed root service cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-updater-failure-"));
    const statePath = join(root, "state.json");
    const updater = new BoatUpdater({ statePath, currentRelease: root, requestPath: join(root, "request.json"), privilegedStart: async () => { throw new Error("service unavailable"); } });
    await expect(updater.start("v2.0.0")).rejects.toThrow("service unavailable");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ requestedVersion: "v2.0.0", phase: "failed" });
  });
});

describe("Boat maintenance admission", () => {
  it("restores maintenance after restart and releases it when the root job fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-maintenance-"));
    const statePath = join(root, "state.json");
    const job = { id: "job", requestedVersion: "v1.1.0", phase: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeFile(statePath, JSON.stringify(job));
    let updating = false;
    const updater = new BoatUpdater({statePath, currentRelease: root});
    updater.attachWorkspace({assertIdle: async () => {}, setUpdating: value => { updating = value; }});
    await updater.reconcile(); expect(updating).toBe(true);
    await writeFile(statePath, JSON.stringify({...job, phase: "failed", error: "download failed"}));
    await updater.reconcile(); expect(updating).toBe(false);
  });

  it("rejects active work without invoking the privileged service", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-busy-"));
    let invoked = false;
    const updater = new BoatUpdater({statePath: join(root,"state.json"), currentRelease: root, fetcher: async () => new Response("missing",{status:404}), privilegedStart: async () => { invoked = true; }});
    updater.attachWorkspace({assertIdle: async () => {throw new Error("Active work");}, setUpdating: () => { throw new Error("must not freeze active work"); }});
    await expect(updater.start("v1.2.3")).rejects.toThrow("Active work");
    expect(invoked).toBe(false);
    await expect(readFile(join(root,"state.json"))).rejects.toMatchObject({code:"ENOENT"});
  });

  it("does not offer an older release as an update", async () => {
    const root = await mkdtemp(join(tmpdir(), "boat-version-"));
    await writeFile(join(root,"boat-release.json"), JSON.stringify({version:"v1.10.0"}));
    const updater = new BoatUpdater({statePath: join(root,"state.json"), currentRelease: root, fetcher: async () => new Response(JSON.stringify({version:"v1.9.0",commit:"a".repeat(40),archive:{file:"boat-bundle.tar.gz",size:1,sha256:"b".repeat(64)}}))});
    await expect(updater.status()).resolves.toMatchObject({available:false,currentVersion:"v1.10.0"});
  });
});
