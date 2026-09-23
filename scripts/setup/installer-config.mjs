import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const INSTANCE_TYPES = ["standard-1", "standard-2", "standard-3", "standard-4"];
export const DEFAULT_CONFIG = { schemaVersion: 1, name: "ocbot-personal", bucketName: "ocbot-personal-artifacts", instanceType: "standard-2", maxConcurrentRuns: 2 };

export function validateInstallerConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment config must be an object");
  if (!/^[a-z][a-z0-9-]{2,52}$/.test(value.name ?? "")) throw new Error("deployment name must be 3-53 lowercase letters, numbers, or hyphens and start with a letter");
  if (!INSTANCE_TYPES.includes(value.instanceType)) throw new Error(`instanceType must be one of: ${INSTANCE_TYPES.join(", ")}`);
  if (!Number.isSafeInteger(value.maxConcurrentRuns) || value.maxConcurrentRuns < 1 || value.maxConcurrentRuns > 4) throw new Error("maxConcurrentRuns must be an integer from 1 to 4");
  const expectedBucket = `${value.name}-artifacts`;
  if (value.bucketName !== expectedBucket) throw new Error(`bucketName must be ${expectedBucket}`);
  return { ...DEFAULT_CONFIG, ...value, schemaVersion: 1 };
}

export function readInstallerConfig(file) {
  try { return validateInstallerConfig(JSON.parse(readFileSync(file, "utf8"))); }
  catch (error) { throw new Error(`invalid deployment configuration: ${error.message}`); }
}

export function writeInstallerConfig(file, input) {
  const config = validateInstallerConfig(input);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return config;
}
