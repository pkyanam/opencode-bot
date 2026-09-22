import { describe, expect, it } from "vitest";
import { computerLabelFromState, storageDescription } from "./hosting-ui";

describe("hosting UI fallbacks", () => {
  it("uses the server computer label when available and a neutral fallback otherwise", () => {
    expect(computerLabelFromState({ deployment: { host: "boat", computerLabel: "Boat computer" } })).toBe("Boat computer");
    expect(computerLabelFromState(undefined)).toBe("Shared computer");
  });

  it("describes local storage without assuming a provider or pricing model", () => {
    expect(storageDescription({ storage: { backend: "local", supportsAutomaticCheckpoints: true, durable: true, metered: false, scope: "artifact-objects" } }).toLowerCase()).toContain("local");
    expect(storageDescription(undefined)).toBe("Measured persistent storage for this workspace.");
  });
});
