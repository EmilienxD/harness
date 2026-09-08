import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";


const root = process.cwd();
const output = join(root, "dist", "aboard-0.0.0.vsix");

const required = [
  "dist/extension.js",
  "assets/aboard.svg",
  "assets/runtime/abd_hook.py",
  "assets/runtime/abd-hooks.json",
  "assets/runtime/abd_wrapper.py",
  // Under `.abd/`, not `.claude/agents/`: a definition in the latter is a
  // subagent type every session in the workspace can discover and spawn.
  "assets/scaffold/.abd/agents/manager.md",
  "assets/scaffold/.abd/agents/Explore.md",
  // Both ship: the project is cloned on every platform, and the file for the
  // one aboard is not running on is still the user's to edit.
  "assets/scaffold/.abd/session-setup.ps1",
  "assets/scaffold/.abd/session-setup.sh",
  "assets/scaffold/.abd/skills/update-todo/SKILL.md",
  "assets/scaffold/.abd/skills/brainstorm/SKILL.md",
  "assets/scaffold/.abd/skills/general-purpose/SKILL.md",
  "LICENSE",
];

const forbidden = [
  // Runtime state belongs to a live workspace and must never ship.
  /(^|\/)\.abd\/runtime(\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)bridge\.json$/,
  /(^|\/)manager\.json$/,
  /(^|\/)fleet\.json$/,
  /(^|\/)prompts(\/|$)/,
  /(^|\/)abd_cli\.py$/,
  /assets\/scaffold\/\.abd\/agents\/(?:implementer|pr-doctor-(?:afk|hitl))\.md$/,
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
