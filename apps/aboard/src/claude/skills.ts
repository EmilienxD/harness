import { stat } from "node:fs/promises";
import { join } from "node:path";

import { claudeConfigDirectory } from "./sessions.js";

export const REQUIRED_HARNESS_WORKER_SKILLS = ["address-this", "review-this"] as const;

export async function harnessSkillIsResolvable(
  workspaceRoot: string,
  skillName: string,
  configDirectory: string = claudeConfigDirectory(),
): Promise<boolean> {
  const candidates = [
    join(workspaceRoot, ".claude", "skills", skillName, "SKILL.md"),
    join(configDirectory, "skills", skillName, "SKILL.md"),
  ];
  const results = await Promise.all(candidates.map((path) => stat(path).then((entry) => entry.isFile(), () => false)));
  return results.some(Boolean);
}

export async function requireHarnessSkill(
  workspaceRoot: string,
  skillName: string,
  configDirectory: string = claudeConfigDirectory(),
): Promise<void> {
  if (await harnessSkillIsResolvable(workspaceRoot, skillName, configDirectory)) return;
  throw new Error(
    `Required Harness skill /${skillName} is not installed. Rerun the Harness installer with Aboard selected.`,
  );
}

export async function requireHarnessWorkerSkills(
  workspaceRoot: string,
  configDirectory: string = claudeConfigDirectory(),
): Promise<void> {
  for (const skill of REQUIRED_HARNESS_WORKER_SKILLS) {
    await requireHarnessSkill(workspaceRoot, skill, configDirectory);
  }
}
