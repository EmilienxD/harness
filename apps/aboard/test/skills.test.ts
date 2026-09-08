import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { harnessSkillIsResolvable, requireHarnessSkill, requireHarnessWorkerSkills } from "../src/claude/skills.js";

test("required worker skills resolve from project or personal Claude skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  const project = join(root, "project");
  const personal = join(root, "personal");
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await harnessSkillIsResolvable(project, "implement", personal), false);

  const projectSkill = join(project, ".claude", "skills", "implement", "SKILL.md");
  await mkdir(projectSkill, { recursive: true });
  assert.equal(await harnessSkillIsResolvable(project, "implement", personal), false);
  await rm(projectSkill, { recursive: true });
  await writeFile(projectSkill, "");
  assert.equal(await harnessSkillIsResolvable(project, "implement", personal), true);
  await rm(join(project, ".claude"), { recursive: true });

  const personalSkill = join(personal, "skills", "implement", "SKILL.md");
  await mkdir(dirname(personalSkill), { recursive: true });
  await writeFile(personalSkill, "");
  assert.equal(await harnessSkillIsResolvable(project, "implement", personal), true);
});

test("missing worker skill reports the Harness installation repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    requireHarnessSkill(join(root, "project"), "review-afk", join(root, "personal")),
    /Required Harness skill \/review-afk is not installed.*Harness installer/u,
  );
});

test("Aboard requires all three empty worker skill placeholders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  const personal = join(root, "personal");
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const skill of ["implement", "review-afk", "review-hitl"]) {
    const path = join(personal, "skills", skill, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
  }

  await requireHarnessWorkerSkills(join(root, "project"), personal);
  await rm(join(personal, "skills", "review-hitl", "SKILL.md"));
  await assert.rejects(
    requireHarnessWorkerSkills(join(root, "project"), personal),
    /Required Harness skill \/review-hitl is not installed/u,
  );
});
