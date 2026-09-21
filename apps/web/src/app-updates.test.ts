import { describe, expect, it } from "vitest";
import { updatePhaseLabel } from "./components/app-updates";

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
    expect(updatePhaseLabel("rollback_required")).toBe("Update needs attention");
  });
});
