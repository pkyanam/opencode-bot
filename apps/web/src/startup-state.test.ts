import { describe, expect, it } from "vitest";
import { isComputerWarmingUpError } from "./api";

describe("computer startup errors", () => {
  it("recognizes the explicit startup response", () => {
    const error = Object.assign(new Error("Your computer is starting"), {
      status: 503,
    });
    expect(isComputerWarmingUpError(error)).toBe(true);
  });

  it("recognizes a startup message even when a proxy removes the status", () => {
    expect(
      isComputerWarmingUpError(
        new Error("Computer is warming up in the background"),
      ),
    ).toBe(true);
  });

  it("leaves genuine connection and runtime failures visible", () => {
    expect(
      isComputerWarmingUpError(
        Object.assign(new Error("internal error"), { status: 500 }),
      ),
    ).toBe(false);
    expect(
      isComputerWarmingUpError(
        new Error("Connection needs attention. Update the application token in Settings."),
      ),
    ).toBe(false);
    expect(
      isComputerWarmingUpError(
        Object.assign(new Error("Computer could not be started"), {
          status: 503,
          code: "computer_unavailable",
        }),
      ),
    ).toBe(false);
  });
});
