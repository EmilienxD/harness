import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";


const root = process.cwd();

const required = [
  "dist/extension.js",
  "assets/aboard.png",
  "assets/aboard.svg",
  "assets/launch.schema.json",
  "assets/runtime/abd_hook.py",
  "assets/runtime/abd-hooks.json",
  "assets/runtime/abd_wrapper.py",
  "assets/scaffold/.harness/launch.json",
  "assets/scaffold/.abd/session-setup.ps1",
  "assets/scaffold/.abd/session-setup.sh",
  "LICENSE",
];

const forbidden = [
  // Runtime state belongs to a live workspace and must never ship.
  /(^|\/)\.abd\/runtime(\/|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)bridge\.json$/,

  /(^|\/)fleet\.json$/,
  /(^|\/)prompts(\/|$)/,
  /(^|\/)abd_cli\.py$/,
  /assets\/scaffold\/\.abd\/(?:agents|skills)(?:\/|$)/,
  /(^|\/)test(\/|$)/,
  /(^|\/)src(\/|$)/,
];

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must contain a non-empty version");
  }
  const output = join(root, "dist", `aboard-${packageJson.version}.vsix`);
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
