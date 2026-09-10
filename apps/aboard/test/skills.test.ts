import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { chatGptSkillIsResolvable, requireChatGptWorkerSkills } from "../src/chatgpt/skills.js";
import { harnessSkillIsResolvable, requireHarnessSkill, requireHarnessWorkerSkills } from "../src/claude/skills.js";

test("required worker skills resolve from project or personal Claude skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  const project = join(root, "project");
  const personal = join(root, "personal");
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await harnessSkillIsResolvable(project, "address-issue", personal), false);

  const projectSkill = join(project, ".claude", "skills", "address-issue", "SKILL.md");
  await mkdir(projectSkill, { recursive: true });
  assert.equal(await harnessSkillIsResolvable(project, "address-issue", personal), false);
  await rm(projectSkill, { recursive: true });
  await writeFile(projectSkill, "");
  assert.equal(await harnessSkillIsResolvable(project, "address-issue", personal), true);
  await rm(join(project, ".claude"), { recursive: true });

  const personalSkill = join(personal, "skills", "address-issue", "SKILL.md");
  await mkdir(dirname(personalSkill), { recursive: true });
  await writeFile(personalSkill, "");
  assert.equal(await harnessSkillIsResolvable(project, "address-issue", personal), true);
});

test("missing worker skill reports the Harness installation repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    requireHarnessSkill(join(root, "project"), "review-issue", join(root, "personal")),
    /Required Harness skill \/review-issue is not installed.*Harness installer/u,
  );
});

test("Aboard requires both empty worker skill placeholders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-skills-"));
  const personal = join(root, "personal");
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const skill of ["address-issue", "review-issue"]) {
    const path = join(personal, "skills", skill, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
  }

  await requireHarnessWorkerSkills(join(root, "project"), personal);
  await rm(join(personal, "skills", "review-issue", "SKILL.md"));
  await assert.rejects(
    requireHarnessWorkerSkills(join(root, "project"), personal),
    /Required Harness skill \/review-issue is not installed/u,
  );
});

test("the ChatGPT worker skills resolve from the repository or the user's agent skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-chatgpt-skills-"));
  const project = join(root, "project");
  const home = join(root, "home");
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await chatGptSkillIsResolvable(project, "address-issue", home), false);
  await assert.rejects(
    requireChatGptWorkerSkills(project, home),
    /Required Harness skill \$address-issue is not installed for ChatGPT.*Harness installer/u,
  );

  const projectSkill = join(project, ".agents", "skills", "address-issue", "SKILL.md");
  await mkdir(dirname(projectSkill), { recursive: true });
  await writeFile(projectSkill, "");
  assert.equal(await chatGptSkillIsResolvable(project, "address-issue", home), true);
  await rm(join(project, ".agents"), { recursive: true });

  for (const skill of ["address-issue", "review-issue"]) {
    const userSkill = join(home, ".agents", "skills", skill, "SKILL.md");
    await mkdir(dirname(userSkill), { recursive: true });
    await writeFile(userSkill, "");
  }
  await requireChatGptWorkerSkills(project, home);
  await rm(join(home, ".agents", "skills", "review-issue", "SKILL.md"));
  await assert.rejects(
    requireChatGptWorkerSkills(project, home),
    /Required Harness skill \$review-issue is not installed for ChatGPT/u,
  );
});
