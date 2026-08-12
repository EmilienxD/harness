import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";

import { VENDORED_SKILLS } from "../src/scaffold/project.js";

const root = process.cwd();
const output = join(root, "dist", "aboard-0.0.0.vsix");

const required = [
  "dist/extension.js",
  "assets/aboard.svg",
  "assets/scaffold/.claude/hooks/aboard_hook.py",
  "assets/scaffold/.claude/hooks/aboard-hooks.json",
  "assets/scaffold/.aboard/scripts/aboard_wrapper.py",
  // Under `.aboard/`, not `.claude/agents/`: a definition in the latter is a
  // subagent type every session in the workspace can discover and spawn.
  "assets/scaffold/.aboard/agents/manager.md",
  "assets/scaffold/.aboard/agents/implementer.md",
  "assets/scaffold/.claude/skills/update-todo/SKILL.md",
  "assets/scaffold/.claude/skills/brainstorm/SKILL.md",
  "assets/scaffold/.claude/skills/raw/SKILL.md",
];

const forbidden = [
  // User-owned skills are installed from upstream by command; a copy in the VSIX
  // would resurrect the drift that removing them was meant to end.
  ...VENDORED_SKILLS.map((skill) => new RegExp(`(^|/)\\.claude/skills/${skill.name}(/|$)`)),
  // Runtime state belongs to a live project and must never ship, but
  // `assets/scaffold/.aboard/scripts/` is extension-owned and legitimately
  // packaged (it is installed by the scaffolder like every other asset).
  /(^|\/)\.aboard\/runtime(\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)bridge\.json$/,
  /(^|\/)manager\.json$/,
  /(^|\/)fleet\.json$/,
  /(^|\/)prompts(\/|$)/,
  /(^|\/)test(\/|$)/,
  /(^|\/)src(\/|$)/,
];

async function main(): Promise<void> {
  const files = (await listFiles({ cwd: root, packageManager: PackageManager.None }))
    .map((file) => file.replaceAll("\\", "/"));
  const missing = required.filter((file) => !files.includes(file));
  const excluded = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (missing.length > 0 || excluded.length > 0) {
    throw new Error([
      ...(missing.length === 0 ? [] : [`VSIX is missing required files: ${missing.join(", ")}`]),
      ...(excluded.length === 0 ? [] : [`VSIX would include forbidden files: ${excluded.join(", ")}`]),
    ].join("\n"));
  }

  await mkdir(join(root, "dist"), { recursive: true });
  await rm(output, { force: true });
  await createVSIX({ cwd: root, packagePath: output, dependencies: false });
  const packaged = await stat(output);
  if (!packaged.isFile() || packaged.size === 0) throw new Error("VSIX packaging produced no artifact");
  process.stdout.write(`Verified ${files.length} packaged files and wrote ${output}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "VSIX packaging failed"}\n`);
  process.exitCode = 1;
});
