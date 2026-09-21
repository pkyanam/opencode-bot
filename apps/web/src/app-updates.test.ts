import { describe, expect, it } from "vitest";
import { updatePhaseLabel, needsClientReload } from "./components/app-updates";

describe("application update progress", () => {
  it("maps updater phases to readable user-facing copy", () => {
    const phases: Record<string, string> = {
      queued: "Waiting to start",
      downloading: "Downloading the update",
      verified: "Release verified",
      quiescing: "Waiting for active work to finish",
      checkpointing: "Saving the Computer checkpoint",
      uploading_assets: "Uploading app assets",
      uploading_worker: "Uploading the app update",
      promoting: "Activating the app update",
      rolling_out_container: "Updating the Computer image",
      waiting_container: "Waiting for the Computer",
      restoring: "Restoring the Computer checkpoint",
      health_check: "Checking the updated app",
      completed: "Update complete",
      failed: "Update failed",
    };
    for (const [phase, label] of Object.entries(phases)) {
      expect(updatePhaseLabel(phase)).toBe(label);
    }
    expect(updatePhaseLabel("rollback_required")).toBe(
      "Update needs attention",
    );
  });
});

it("asks for a reload only when a completed update is newer than the loaded client", () => {
  const job = { phase: "completed", requestedVersion: "v0.1.12" };
  expect(needsClientReload(job, "0.1.11")).toBe(true);
  expect(needsClientReload(job, "0.1.12")).toBe(false);
  expect(needsClientReload(job, "0.1.13")).toBe(false);
  expect(needsClientReload({ ...job, phase: "restoring" }, "0.1.11")).toBe(
    false,
  );
  expect(needsClientReload(undefined, "0.1.12")).toBe(false);
});
