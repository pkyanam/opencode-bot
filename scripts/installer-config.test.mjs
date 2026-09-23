import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, INSTANCE_TYPES, validateInstallerConfig, writeInstallerConfig } from "./setup/installer-config.mjs";

test("Cloudflare installer config validates supported compute sizes and derived bucket", () => {
  assert.deepEqual(validateInstallerConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  for (const instanceType of INSTANCE_TYPES) assert.equal(validateInstallerConfig({ ...DEFAULT_CONFIG, instanceType }).instanceType, instanceType);
  assert.throws(() => validateInstallerConfig({ ...DEFAULT_CONFIG, name: "Bad Name" }), /deployment name/);
  assert.throws(() => validateInstallerConfig({ ...DEFAULT_CONFIG, instanceType: "huge" }), /instanceType/);
  assert.throws(() => validateInstallerConfig({ ...DEFAULT_CONFIG, bucketName: "unrelated" }), /bucketName/);
});

test("Cloudflare installer config is private and round trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbot-config-"));
  const file = join(dir, "nested", "deployment-config.json");
  const config = writeInstallerConfig(file, { ...DEFAULT_CONFIG, name: "my-bot", bucketName: "my-bot-artifacts", instanceType: "standard-3" });
  assert.equal(config.name, "my-bot");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), config);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
