import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const REQUIRED_CHATGPT_WORKER_SKILLS = ["address-this", "review-this"] as const;

export function chatGptSkillDirectories(workspaceRoot: string, homeDirectory: string = homedir()): readonly string[] {
  return [
    join(workspaceRoot, ".agents", "skills"),
    join(homeDirectory, ".agents", "skills"),
    ...(process.platform === "win32" ? [] : [join("/etc", "codex", "skills")]),
  ];
}

export async function chatGptSkillIsResolvable(
  workspaceRoot: string,
  skillName: string,
  homeDirectory: string = homedir(),
): Promise<boolean> {
  const candidates = chatGptSkillDirectories(workspaceRoot, homeDirectory).map((directory) => join(directory, skillName, "SKILL.md"));
  const results = await Promise.all(candidates.map((path) => stat(path).then((entry) => entry.isFile(), () => false)));
  return results.some(Boolean);
}

export async function requireChatGptSkill(
  workspaceRoot: string,
  skillName: string,
  homeDirectory: string = homedir(),
): Promise<void> {
  if (await chatGptSkillIsResolvable(workspaceRoot, skillName, homeDirectory)) return;
  throw new Error(
    `Required Harness skill $${skillName} is not installed for ChatGPT. Rerun the Harness installer with Aboard selected and ChatGPT as the target.`,
  );
}

export async function requireChatGptWorkerSkills(
  workspaceRoot: string,
  homeDirectory: string = homedir(),
): Promise<void> {
  for (const skill of REQUIRED_CHATGPT_WORKER_SKILLS) {
    await requireChatGptSkill(workspaceRoot, skill, homeDirectory);
  }
}
