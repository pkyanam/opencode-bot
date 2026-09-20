import { existsSync, lstatSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const PLAYWRIGHT_MCP_VERSION = "0.0.82";
export const DEFAULT_BROWSER_PROFILE = "/workspace/browser/profile";
export const DEFAULT_BROWSER_OUTPUT = "/workspace/browser/output";

export type BrowserMcpOptions = {
  command?: string;
  profileDir?: string;
  outputDir?: string;
  cwd?: string;
  headless?: boolean;
  browser?: "chrome" | "firefox" | "webkit" | "msedge";
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  timeoutActionMs?: number;
  timeoutNavigationMs?: number;
  idleTimeoutMs?: number;
  executablePath?: string;
  noSandbox?: boolean;
  /** Attach to the headed desktop browser over CDP instead of starting one. */
  cdpEndpoint?: string;
  cdpTimeoutMs?: number;
};

/**
 * Native OpenCode 2 `mcp.servers` entry for Playwright MCP.
 *
 * The command is intentionally an executable name rather than `npx`: images
 * should install and pin @playwright/mcp during build, so a run cannot fetch
 * arbitrary code from the network. The profile and output directories are
 * inside the sandbox workspace and can be included by a future checkpoint.
 */
export function createPlaywrightMcpServer(options: BrowserMcpOptions = {}) {
  const args = [
    "--output-dir",
    options.outputDir ?? DEFAULT_BROWSER_OUTPUT,
    "--file-paths",
    "relative",
  ];
  if (options.cdpEndpoint) {
    args.push("--cdp-endpoint", options.cdpEndpoint);
    if (options.cdpTimeoutMs !== undefined) args.push("--cdp-timeout", String(options.cdpTimeoutMs));
  } else {
    args.unshift("--user-data-dir", options.profileDir ?? DEFAULT_BROWSER_PROFILE);
  }
  if (options.browser) args.push("--browser", options.browser);
  if (options.executablePath) args.push("--executable-path", options.executablePath);
  if (options.noSandbox ?? true) args.push("--no-sandbox");
  // The current Playwright MCP CLI accepts --headless as a flag. Keep the
  // default explicit in generated config so a headed desktop is never assumed.
  // A CDP target is already running headed on the shared X display. Passing
  // --headless here would make the MCP client try to launch a second browser.
  if (!options.cdpEndpoint && (options.headless ?? true)) args.push("--headless");
  if (options.allowedOrigins?.length) args.push("--allowed-origins", options.allowedOrigins.join(";"));
  if (options.blockedOrigins?.length) args.push("--blocked-origins", options.blockedOrigins.join(";"));
  if (options.timeoutActionMs !== undefined) args.push("--timeout-action", String(options.timeoutActionMs));
  if (options.timeoutNavigationMs !== undefined) args.push("--timeout-navigation", String(options.timeoutNavigationMs));
  if (options.idleTimeoutMs !== undefined) args.push("--idle-timeout", String(options.idleTimeoutMs));

  return {
    type: "local" as const,
    command: [options.command ?? "playwright-mcp", ...args],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    timeout: {
      startup: 30_000,
      catalog: 30_000,
      execution: 120_000,
    },
  };
}

export type WorkspaceArtifact = {
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
};

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function assertInside(root: string, candidate: string) {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  if (candidateResolved !== rootResolved && !candidateResolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new WorkspacePathError("Path escapes the workspace root");
  }
  return candidateResolved;
}

/** Resolve a user supplied relative path while rejecting absolute and `..` escapes. */
export function resolveWorkspacePath(root: string, requested = ".") {
  if (path.isAbsolute(requested)) throw new WorkspacePathError("Absolute paths are not allowed");
  const candidate = assertInside(root, path.resolve(root, requested));
  // Existing symlinks are checked against their real target. This prevents a
  // browser tool from turning an apparently safe download into host access.
  if (existsSync(candidate)) {
    const realRoot = realpathSync(path.resolve(root));
    const realCandidate = realpathSync(candidate);
    assertInside(realRoot, realCandidate);
    // Reject symlinks even when their target remains inside the workspace.
    // Artifact paths are checkpointable names, so following links would make
    // identity and authorization ambiguous and could change between calls.
    let lexical = path.resolve(root);
    for (const segment of path.relative(path.resolve(root), candidate).split(path.sep).filter(Boolean)) {
      lexical = path.join(lexical, segment);
      if (lstatSync(lexical).isSymbolicLink()) throw new WorkspacePathError("Symbolic links are not allowed");
    }
  }
  return candidate;
}

/** Return a regular file suitable for a download or attachment. */
export async function resolveWorkspaceFile(root: string, requested: string) {
  const candidate = resolveWorkspacePath(root, requested);
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new WorkspacePathError("Workspace file does not exist");
  }
  if (!info.isFile()) throw new WorkspacePathError("Workspace path is not a regular file");
  return candidate;
}

/** List files/directories without following symlinks. Paths are root-relative. */
export async function listWorkspaceArtifacts(root: string, requested = ".", maxEntries = 500): Promise<WorkspaceArtifact[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new RangeError("maxEntries must be between 1 and 10000");
  const base = resolveWorkspacePath(root, requested);
  const result: WorkspaceArtifact[] = [];
  async function walk(current: string) {
    if (result.length >= maxEntries) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= maxEntries) return;
      const full = path.join(current, entry.name);
      const relative = path.relative(path.resolve(root), full) || ".";
      const linkInfo = lstatSync(full);
      if (linkInfo.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        result.push({ path: relative, kind: "directory", size: 0, modifiedAt: linkInfo.mtime.toISOString() });
        await walk(full);
      } else if (entry.isFile()) {
        result.push({ path: relative, kind: "file", size: linkInfo.size, modifiedAt: linkInfo.mtime.toISOString() });
      }
    }
  }
  const info = await stat(base);
  if (info.isDirectory()) await walk(base);
  else if (info.isFile()) result.push({ path: path.relative(path.resolve(root), base), kind: "file", size: info.size, modifiedAt: info.mtime.toISOString() });
  else throw new WorkspacePathError("Workspace path is not a regular file or directory");
  return result;
}
