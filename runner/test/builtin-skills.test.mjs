import test from "node:test";
import assert from "node:assert/strict";
import { builtinSkillFiles, builtinSkillPayload, installBuiltinSkill, listBuiltinSkills } from "../builtin-skills.mjs";

test("built-in self-development skill is a bounded inert install payload", async () => {
  const payload = await builtinSkillPayload("opencode-bot-self-development");
  assert.equal(payload.skillName, "opencode-bot-self-development");
  assert.deepEqual(payload.files.map((file) => file.path), [
    "SKILL.md",
    "references/change-release.md",
    "references/deployment.md",
    "references/identity.md",
    "references/sources.md",
  ]);
  for (const file of payload.files) {
    assert.ok(!file.path.includes(".."));
    assert.match(file.contentBase64, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
  }
  const markdown = Buffer.from(payload.files[0].contentBase64, "base64").toString("utf8");
  assert.match(markdown, /^---\nname: opencode-bot-self-development\n/);
  assert.doesNotMatch(markdown, /API_KEY|TOKEN=|BEGIN .* PRIVATE KEY/);
});

test("built-in skill loader is deterministic and does not mutate the source tree", async () => {
  const before = await listBuiltinSkills();
  const first = await builtinSkillFiles("opencode-bot-self-development");
  const second = await builtinSkillFiles("opencode-bot-self-development");
  assert.deepEqual(first, second);
  assert.deepEqual(before, [{ name: "opencode-bot-self-development", files: ["SKILL.md", "references/change-release.md", "references/deployment.md", "references/identity.md", "references/sources.md"], bytes: before[0].bytes, hasEntry: true }]);
});

test("unknown built-in skills are rejected", async () => {
  await assert.rejects(() => builtinSkillFiles("unknown"), /unknown built-in skill/);
});

test("built-in installation is restart-safe and preserves an existing user skill", async () => {
  let calls = 0;
  const installer = { async installSkill(payload) {
    calls += 1;
    assert.equal(payload.skillName, "opencode-bot-self-development");
    if (calls === 2) throw Object.assign(new Error("skill is already installed"), { statusCode: 409 });
    return { installed: true, name: payload.skillName };
  } };
  assert.deepEqual(await installBuiltinSkill(installer, "opencode-bot-self-development"), { installed: true, name: "opencode-bot-self-development" });
  assert.deepEqual(await installBuiltinSkill(installer, "opencode-bot-self-development"), { installed: false, preserved: true, name: "opencode-bot-self-development" });
  assert.equal(calls, 2);
});
