import type { State, StorageSummary } from "./api";

/** Labels supplied by the control server are optional for older installations. */
export const computerLabelFromState = (state?: Pick<State, "deployment" | "host">) =>
  state?.deployment?.computerLabel ?? state?.host?.computerLabel ?? "Shared computer";

export const storageDescription = (summary?: Pick<StorageSummary, "description" | "storage">) =>
  summary?.description ??
  (summary?.storage?.backend === "local"
    ? "Local backup and artifact storage. This meter excludes workspace files and other VM disk usage."
    : "Measured persistent storage for this workspace.");
