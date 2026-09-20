import assert from "node:assert/strict";
import test from "node:test";
import {
  markerForCheckpoint,
  parseAppToken,
  plannedRestartDecision,
  projectContainerPrefix,
} from "./preview-lifecycle.mjs";

test("scopes Docker cleanup to the configured Sandbox class", () => {
  assert.equal(
    projectContainerPrefix("ocbot-personal"),
    "workerd-ocbot-personal-Sandbox-",
  );
  assert.throws(() => projectContainerPrefix("ocbot/personal"), /unsafe/);
});

test("resolves APP_TOKEN without logging or accepting arbitrary flags", () => {
  assert.equal(parseAppToken(["--var", "APP_TOKEN:from-cli"], {}), "from-cli");
  assert.equal(parseAppToken([], {}, "APP_TOKEN=from-file\n"), "from-file");
  assert.equal(
    parseAppToken([], { APP_TOKEN: "from-env" }, "APP_TOKEN=from-file"),
    "from-env",
  );
  assert.equal(parseAppToken(["--var", "OTHER:value"], {}), undefined);
});

test("only restores a checkpoint explicitly marked by a successful planned shutdown", () => {
  assert.deepEqual(
    plannedRestartDecision({
      markerId: "cp1",
      checkpointId: "cp1",
      readiness: "restore_required",
    }),
    { action: "restore" },
  );
  assert.deepEqual(
    plannedRestartDecision({
      markerId: "cp1",
      checkpointId: "cp2",
      readiness: "restore_required",
    }).action,
    "manual",
  );
  assert.deepEqual(
    plannedRestartDecision({
      markerId: undefined,
      checkpointId: "cp1",
      readiness: "restore_required",
    }),
    { action: "none" },
  );
  assert.deepEqual(
    plannedRestartDecision({
      markerId: "cp1",
      checkpointId: "cp1",
      readiness: "ready",
    }),
    { action: "clear" },
  );
});

test("checkpoint marker requires a durable checkpoint id", () => {
  assert.equal(
    markerForCheckpoint({ checkpoint: { id: "cp1" } }).checkpointId,
    "cp1",
  );
  assert.throws(
    () => markerForCheckpoint({ status: "committed" }),
    /did not include/,
  );
});
