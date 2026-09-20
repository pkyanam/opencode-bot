/** Pure lifecycle decisions shared by the stable preview wrapper and tests. */
export function projectContainerPrefix(projectName, className = "Sandbox") {
  if (!/^[a-z0-9_-]+$/i.test(projectName) || !/^[a-z0-9_-]+$/i.test(className))
    throw new Error("unsafe Wrangler container identity");
  return `workerd-${projectName}-${className}-`;
}

export function parseAppToken(args = [], environment = {}, devVars = "") {
  if (environment.APP_TOKEN) return environment.APP_TOKEN;
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === "--var" && args[i + 1].startsWith("APP_TOKEN:"))
      return args[i + 1].slice("APP_TOKEN:".length);
  return devVars.match(/^APP_TOKEN=(.*)$/m)?.[1]?.trim() || undefined;
}

export function plannedRestartDecision({ markerId, checkpointId, readiness }) {
  if (!markerId) return { action: "none" };
  if (!checkpointId || markerId !== checkpointId)
    return {
      action: "manual",
      reason: "planned restart marker does not match the committed checkpoint",
    };
  if (readiness === "restore_required" || readiness === "recovering")
    return { action: "restore" };
  if (readiness === "ready") return { action: "clear" };
  return {
    action: "manual",
    reason: `computer readiness is ${readiness || "unknown"}`,
  };
}

export function markerForCheckpoint(checkpoint) {
  const id = checkpoint?.checkpoint?.id ?? checkpoint?.id;
  if (typeof id !== "string" || !id)
    throw new Error("checkpoint response did not include an id");
  return { version: 1, checkpointId: id, createdAt: new Date().toISOString() };
}
