import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { piAgentDirectory } from "./sessions.js";

export async function requirePiWorkerSkills(workspaceRoot: string): Promise<void> {
  const roots = [join(workspaceRoot, ".pi", "skills"), join(piAgentDirectory(), "skills"), join(homedir(), ".agents", "skills")];
  for (let directory = resolve(workspaceRoot); ; directory = dirname(directory)) {
    roots.push(join(directory, ".agents", "skills"));
    if (await stat(join(directory, ".git")).then(() => true, () => false) || dirname(directory) === directory) break;
  }
  for (const [base, settings] of [[workspaceRoot, join(workspaceRoot, ".pi", "settings.json")], [piAgentDirectory(), join(piAgentDirectory(), "settings.json")]] as const) {
    try {
      const input = JSON.parse(await readFile(settings, "utf8")) as { skills?: unknown };
      if (Array.isArray(input.skills)) for (const path of input.skills) {
        if (typeof path === "string" && !path.startsWith("-")) roots.push(resolve(base, path.replace(/^~(?=[/\\])/u, homedir())));
      }
    } catch { /* Native launch reports malformed settings. */ }
  }
  for (const name of ["address-this", "review-this"]) {
    const found = await Promise.all(roots.flatMap((root) => [join(root, name, "SKILL.md"), ...(root.endsWith(name) ? [join(root, "SKILL.md")] : [])]).map((path) => stat(path).then((s) => s.isFile(), () => false)));
    if (!found.some(Boolean)) throw new Error(`Required Harness skill /skill:${name} is not installed for Pi. Install issue-readers for Pi before launching Auto Run.`);
  }
}
