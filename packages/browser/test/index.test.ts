import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlaywrightMcpServer, listWorkspaceArtifacts, resolveWorkspaceFile, resolveWorkspacePath, WorkspacePathError } from "../src/index";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })))); });
async function tempRoot() { const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "opencode-browser-"))); roots.push(root); return root; }

describe("browser MCP config", () => {
  it("generates pinned, headless OpenCode 2 local server config", () => {
    const server = createPlaywrightMcpServer({ profileDir: "/workspace/browser/profile" });
    expect(server.type).toBe("local");
    expect(server.command).toEqual(expect.arrayContaining(["playwright-mcp", "--headless"]));
    expect(server.command).toContain("--no-sandbox");
    expect(server.command).not.toContain(`@playwright/mcp@0.0.82`);
    expect(server.command).toContain("--user-data-dir");
  });

  it("attaches to the shared headed desktop over CDP without a second profile", () => {
    const server = createPlaywrightMcpServer({ cdpEndpoint: "http://127.0.0.1:9222", cdpTimeoutMs: 15_000 });
    expect(server.command).toEqual(expect.arrayContaining(["--cdp-endpoint", "http://127.0.0.1:9222", "--cdp-timeout", "15000"]));
    expect(server.command).not.toContain("--headless");
    expect(server.command).not.toContain("--user-data-dir");
  });
});

describe("workspace artifacts", () => {
  it("rejects escapes and symlink targets", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "ok.txt"), "ok");
    await symlink(os.tmpdir(), path.join(root, "escape"));
    expect(() => resolveWorkspacePath(root, "../outside")).toThrow(WorkspacePathError);
    await expect(resolveWorkspaceFile(root, "escape/file")).rejects.toThrow(WorkspacePathError);
    const entries = await listWorkspaceArtifacts(root);
    expect(entries.map((entry) => entry.path)).toContain("ok.txt");
    expect(entries.map((entry) => entry.path)).not.toContain("escape");
  });

  it("lists nested regular files", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "shot.png"), "data");
    const file = await resolveWorkspaceFile(root, "nested/shot.png");
    expect(file).toBe(path.join(root, "nested", "shot.png"));
    expect((await listWorkspaceArtifacts(root)).some((entry) => entry.path === "nested/shot.png")).toBe(true);
  });
});
