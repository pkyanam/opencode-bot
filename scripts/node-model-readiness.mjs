/**
 * Local model preflight for owned-node runs.
 *
 * The runner catalog is intentionally the only source used here. It tells us
 * whether a model is configured and enabled on this computer; it cannot prove
 * that a provider credential is valid, so this check never makes that claim.
 */

function selection(model) {
  if (model && typeof model === "object") {
    const rawID = model.modelID ?? model.modelId ?? model.id ?? "";
    const id = String(rawID);
    const hash = id.indexOf("#");
    return {
      providerID: String(model.providerID ?? model.providerId ?? ""),
      modelID: hash < 0 ? id : id.slice(0, hash),
      variant: model.variant ?? (hash < 0 ? "" : id.slice(hash + 1)),
    };
  }
  const value = String(model ?? "").trim();
  const separator = value.indexOf("/");
  const reference = separator > 0 ? value.slice(separator + 1) : value;
  const hash = reference.indexOf("#");
  return {
    providerID: separator > 0 ? value.slice(0, separator) : "",
    modelID: hash < 0 ? reference : reference.slice(0, hash),
    variant: hash < 0 ? "" : reference.slice(hash + 1),
  };
}

function modelLabel(model) {
  if (model && typeof model === "object") {
    const provider = model.providerID ?? model.providerId ?? "";
    const id = model.modelID ?? model.modelId ?? model.id ?? "";
    const variant = model.variant ? `#${model.variant}` : "";
    return `${provider ? `${provider}/` : ""}${id}${variant}` || "the selected model";
  }
  const value = String(model ?? "").trim();
  return value || "the selected model";
}

export function assertLocalModelReady(model, catalog) {
  if (model === undefined || model === null || String(model).trim() === "") return { ok: true };
  const wanted = selection(model);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const found = models.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const providerID = String(candidate.providerID ?? "");
    const ids = [candidate.id, candidate.modelID].filter((value) => value !== undefined).map(String);
    if (!ids.includes(wanted.modelID) || (wanted.providerID && providerID !== wanted.providerID)) return false;
    // OpenCode exposes configured variants on each model. Preserve the
    // selected variant in the request, while rejecting an explicitly chosen
    // variant when the catalog proves it is unavailable.
    if (wanted.variant && Array.isArray(candidate.variants) && candidate.variants.length > 0) {
      const variants = candidate.variants.map((variant) => typeof variant === "string" ? variant : variant?.id).filter(Boolean).map(String);
      if (!variants.includes(String(wanted.variant))) return false;
    }
    return true;
  });
  if (!found || found.status !== "active" || found.enabled !== true) {
    throw new Error(`Model ${modelLabel(model)} is not configured on this computer. Configure the provider on this node or choose an available model.`);
  }
  return { ok: true, model: found };
}

export async function checkLocalModelReadiness({ runnerUrl, runnerToken, model, fetchImpl = fetch } = {}) {
  if (model === undefined || model === null || String(model).trim() === "") return { ok: true };
  const base = String(runnerUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const response = await fetchImpl(`${base}/catalog`, {
    headers: { accept: "application/json", ...(runnerToken ? { authorization: `Bearer ${runnerToken}` } : {}) },
    signal: AbortSignal.timeout(5000),
  });
  let catalog = null;
  try { catalog = await response.json(); } catch { /* handled as an unavailable catalog below */ }
  if (!response.ok || !catalog || typeof catalog !== "object") {
    throw new Error("The local model catalog is unavailable. Choose an available model on this computer and try again.");
  }
  return assertLocalModelReady(model, catalog);
}
