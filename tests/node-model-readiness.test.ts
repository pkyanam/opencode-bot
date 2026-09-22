import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error portable executable helper has no declaration file.
import { assertLocalModelReady, checkLocalModelReadiness } from "../scripts/node-model-readiness.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("owned-node model readiness", () => {
  const catalog = {
    models: [
      { providerID: "opencode", id: "big-pickle", modelID: "big-pickle", status: "active", enabled: true },
      { providerID: "local", id: "disabled", modelID: "disabled", status: "active", enabled: false },
      { providerID: "remote", id: "offline", modelID: "offline", status: "disabled", enabled: true },
    ],
  };

  it("accepts an active enabled model from the local catalog", () => {
    expect(assertLocalModelReady("opencode/big-pickle", catalog).ok).toBe(true);
  });

  it("matches a model variant against its base catalog model", () => {
    const withVariants = { models: [{ ...catalog.models[0], variants: [{ id: "balanced" }, { id: "high" }] }] };
    expect(assertLocalModelReady("opencode/big-pickle#high", withVariants).ok).toBe(true);
    expect(() => assertLocalModelReady("opencode/big-pickle#missing", withVariants)).toThrow(/not configured/);
  });

  it("rejects missing, disabled, and inactive models without fallback", () => {
    for (const model of ["opencode/missing", "local/disabled", "remote/offline"]) {
      expect(() => assertLocalModelReady(model, catalog)).toThrow(
        `Model ${model} is not configured on this computer. Configure the provider on this node or choose an available model.`,
      );
    }
  });

  it("does not require a model credential claim for readiness", async () => {
    const fetchImpl = vi.fn(async () => Response.json(catalog));
    await expect(checkLocalModelReadiness({ runnerUrl: "http://127.0.0.1:8787", runnerToken: "runner", model: "opencode/big-pickle", fetchImpl })).resolves.toEqual({ ok: true, model: catalog.models[0] });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/catalog", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer runner" }) }));
  });
});
