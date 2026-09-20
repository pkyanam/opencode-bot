/**
 * OpenCode 2 configuration helpers. This package intentionally does not
 * import @opencode/plugin: browser capability is a native MCP server in V2,
 * and the plugin API is still experimental. Keeping this pure makes config
 * generation testable and avoids accidentally executing extension code in the
 * control plane.
 */
export type McpServer = {
  type: "local" | "remote";
  command?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  url?: string;
  disabled?: boolean;
  timeout?: { startup?: number; catalog?: number; execution?: number };
  protocol?: "legacy" | "auto" | "2026-07-28";
};

export type OpenCodeMcpConfig = {
  mcp: { servers: Record<string, McpServer> };
};

export function withMcpServers(...servers: Array<[string, McpServer] | Record<string, McpServer>>): OpenCodeMcpConfig {
  const merged: Record<string, McpServer> = {};
  for (const group of servers) {
    if (Array.isArray(group)) merged[group[0]] = group[1];
    else Object.assign(merged, group);
  }
  return { mcp: { servers: merged } };
}

export function mergeOpenCodeConfig<T extends Record<string, unknown>>(base: T, mcp: OpenCodeMcpConfig): T & OpenCodeMcpConfig {
  const baseMcp = (base.mcp && typeof base.mcp === "object" ? base.mcp : {}) as { servers?: Record<string, McpServer> };
  return { ...base, mcp: { ...baseMcp, ...mcp.mcp, servers: { ...(baseMcp.servers ?? {}), ...mcp.mcp.servers } } } as T & OpenCodeMcpConfig;
}

