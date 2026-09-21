import { describe, expect, it } from "vitest";
import {
  normalizeTreeFiles,
  parseGitHubRepositoryUrl,
  parseSkillMarkdown,
  safeRelativePath,
  skillDirectoryFromPath,
} from "./extension-repositories";

describe("extension repository validation", () => {
  it("normalizes public repository URLs and rejects credentials", () => {
    expect(parseGitHubRepositoryUrl("https://github.com/acme/skills")).toMatchObject({ owner: "acme", name: "skills", ref: "HEAD", url: "https://github.com/acme/skills" });
    expect(() => parseGitHubRepositoryUrl("https://user:secret@github.com/acme/skills")).toThrow();
    expect(() => parseGitHubRepositoryUrl("https://github.com/acme/skills?download=1")).toThrow();
  });
  it("validates Agent Skills frontmatter and bounded paths", () => {
    expect(parseSkillMarkdown("---\nname: my-skill\ndescription: Does useful work\n---\n# Instructions")).toMatchObject({ name: "my-skill", description: "Does useful work" });
    expect(() => parseSkillMarkdown("---\nname: Bad Name\ndescription: x\n---")).toThrow();
    expect(() => safeRelativePath("../SKILL.md")).toThrow();
    expect(skillDirectoryFromPath("packs/my-skill/SKILL.md")).toBe("packs/my-skill");
  });
  it("selects only bounded files under a skill directory", () => {
    expect(normalizeTreeFiles([{ path: "packs/demo/SKILL.md", type: "blob" }, { path: "packs/demo/references/a.md", type: "blob" }, { path: "packs/demo/.hidden", type: "blob" }], "packs/demo")).toEqual(["packs/demo/SKILL.md", "packs/demo/references/a.md"]);
  });
});

