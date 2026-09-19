import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject } from "../../src/scaffold/project.js";

test("a flat .abd scaffold is recognized as initialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-"));
  const assets = join(root, "assets");
  const project = join(root, "project");
  await mkdir(join(assets, ".abd"), { recursive: true });
  await mkdir(join(assets, ".harness"), { recursive: true });
  await writeFile(join(assets, ".harness", "config.json"), '{"version":1,"providers":{"claude":{},"chatgpt":{}}}\n');
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const revision = await scaffoldCatalogRevision(assets);
  const report = await scaffoldProject({ projectRoot: project, assetRoot: assets });

  assert.deepEqual(report.created, [".abd/session-setup.ps1", ".harness/config.json"]);
  assert.equal(await readScaffoldState(project, revision), "ready");
});

test("a disabled Claude Code auto-compact is reported, and an unset one is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-compact-"));
  const assets = join(root, "assets");
  await mkdir(join(assets, ".abd"), { recursive: true });
  await writeFile(join(assets, ".abd", "session-setup.ps1"), "");

  const warned = await scaffoldProject({ projectRoot: join(root, "off"), assetRoot: assets, autoCompactEnabled: false });
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0]!, /autoCompact/u);

  for (const options of [{ autoCompactEnabled: true }, {}]) {
    const report = await scaffoldProject({ projectRoot: join(root, `on-${String(Object.keys(options).length)}`), assetRoot: assets, ...options });
    assert.deepEqual(report.warnings, []);
  }
});

test("scaffolding merges Aboard hooks into an existing Codex hooks file", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-codex-hooks-"));
  const assets = join(process.cwd(), "assets", "scaffold");
  const project = join(root, "project");
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(join(project, ".codex", "hooks.json"), `${JSON.stringify({
    description: "User hooks",
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "user-start" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-guard" }] }],
    },
  }, null, 2)}\n`);

  const first = await scaffoldProject({ projectRoot: project, assetRoot: assets });
  const hooksPath = join(project, ".codex", "hooks.json");
  const installed = JSON.parse(await readFile(hooksPath, "utf8")) as {
    readonly description: string;
    readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly { readonly command: string; readonly commandWindows?: string }[] }[]>>;
  };

  assert.equal(installed.description, "User hooks");
  assert.equal(installed.hooks.SessionStart?.some((group) => group.hooks.some((hook) => hook.command === "user-start")), true);
  assert.equal(installed.hooks.PreToolUse?.some((group) => group.hooks.some((hook) => hook.command === "user-guard")), true);
  const aboardCommands = Object.values(installed.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
    .filter((hook) => hook.command.includes("ABOARD_RUNTIME_ROOT"));
  assert.equal(aboardCommands.length, 6);
  assert.equal(aboardCommands.every((hook) => hook.command.includes("scripts/abd_hook.py") && hook.commandWindows?.includes("scripts\\abd_hook.py")), true);
  assert.equal(first.updated.includes(".codex/hooks.json"), true);

  const before = await readFile(hooksPath, "utf8");
  await scaffoldProject({ projectRoot: project, assetRoot: assets });
  assert.equal(await readFile(hooksPath, "utf8"), before);
});
