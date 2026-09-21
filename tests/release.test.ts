import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertSourceCommit, downloadReleaseArchive, githubReleaseUrl, validateManifest, verifyArchive, craneAsset } from "../scripts/setup/release.mjs";

const bytes = Buffer.from("archive");
const manifest = { schemaVersion: 1, version: "v0.1.1", commit: "a".repeat(40), platform: "linux/amd64", opencodeVersion: "2.0.11", sandboxVersion: "0.12.9", imageArchive: { file: "computer-image.tar.gz", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } };

describe("release verification", () => {
  it("accepts the pinned manifest and rejects source mismatches", () => {
    expect(validateManifest(manifest).commit).toHaveLength(40);
    expect(() => validateManifest({ ...manifest, platform: "darwin/arm64" })).toThrow(/platform/);
    expect(() => validateManifest({ ...manifest, imageArchive: { ...manifest.imageArchive, sha256: "0".repeat(64) } })).not.toThrow();
    expect(() => assertSourceCommit(manifest, resolve(import.meta.dirname, ".."))).toThrow(/does not match/);
  });

  it("checks archive size and digest", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ocbot-release-"));
    const file = resolve(dir, "computer-image.tar.gz"); writeFileSync(file, bytes);
    expect(verifyArchive(file, manifest.imageArchive).sha256).toBe(manifest.imageArchive.sha256);
    writeFileSync(file, "tampered"); expect(() => verifyArchive(file, manifest.imageArchive)).toThrow(/mismatch/);
  });

  it("constructs only the expected GitHub release URL and pins crane", () => {
    expect(githubReleaseUrl("v0.1.1", "computer-image.tar.gz")).toMatch(/^https:\/\/github\.com\/pkyanam\/opencode-bot\/releases\/download\//);
    expect(() => githubReleaseUrl("v0.1.1", "secrets.txt")).toThrow();
    expect(craneAsset().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads and verifies the release body, removing bad output", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ocbot-release-download-"));
    const file = resolve(dir, "computer-image.tar.gz");
    const good = { ...manifest, imageArchive: { ...manifest.imageArchive } };
    const response = (body: Buffer) => new Response(body.toString(), { status: 200, headers: { "content-type": "application/octet-stream" } });
    await downloadReleaseArchive(good, file, async () => response(bytes));
    expect(readFileSync(file)).toEqual(bytes);
    const bad = { ...good, imageArchive: { ...good.imageArchive, sha256: "0".repeat(64) } };
    await expect(downloadReleaseArchive(bad, resolve(dir, "bad.tar.gz"), async () => response(bytes))).rejects.toThrow(/sha256/);
  });
});
