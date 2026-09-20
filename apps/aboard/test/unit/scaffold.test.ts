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

const legacyAboardHook = (route: string) => ({
  type: "command",
  command: `uv run --no-project --no-managed-python \"$ABOARD_RUNTIME_ROOT/scripts/abd_hook.py\" ${route}`,
  commandWindows: `uv run --no-project --no-managed-python \"$env:ABOARD_RUNTIME_ROOT\\scripts\\abd_hook.py\" ${route}`,
});

test("scaffolding removes only legacy Aboard handlers and preserves arbitrary user hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-codex-hooks-"));
  const assets = join(process.cwd(), "assets", "scaffold");
  const project = join(root, "project");
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(join(project, ".codex", "hooks.json"), `${JSON.stringify({
    description: "User hooks",
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "user-start" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-guard" }, legacyAboardHook("worker-guard")] }],
      Stop: [{ hooks: [legacyAboardHook("worker-stop")] }],
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
  assert.deepEqual(installed.hooks.PreToolUse?.[0]?.hooks.map((hook) => hook.command), ["user-guard"]);
  assert.equal(installed.hooks.Stop, undefined);
  assert.equal(Object.values(installed.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks))
    .some((hook) => hook.command.includes("ABOARD_RUNTIME_ROOT")), false);
  assert.equal(first.updated.includes(".codex/hooks.json"), true);

  const before = await readFile(hooksPath, "utf8");
  await scaffoldProject({ projectRoot: project, assetRoot: assets });
  assert.equal(await readFile(hooksPath, "utf8"), before);
});

test("scaffolding removes a pure legacy Aboard hooks file and never recreates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-scaffold-pure-codex-hooks-"));
  const assets = join(process.cwd(), "assets", "scaffold");
  const project = join(root, "project");
  const hooksPath = join(project, ".codex", "hooks.json");
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: "startup|resume|fork", hooks: [legacyAboardHook("session-start")] }],
      SessionEnd: [{ hooks: [legacyAboardHook("session-end")] }],
    },
  }, null, 2)}\n`);

  const first = await scaffoldProject({ projectRoot: project, assetRoot: assets });
  assert.deepEqual(first.removed, [".codex/hooks.json"]);
  await assert.rejects(readFile(hooksPath, "utf8"), { code: "ENOENT" });

  const second = await scaffoldProject({ projectRoot: project, assetRoot: assets });
  assert.equal(second.created.includes(".codex/hooks.json"), false);
  assert.equal(second.updated.includes(".codex/hooks.json"), false);
  assert.equal(second.removed.includes(".codex/hooks.json"), false);
  await assert.rejects(readFile(hooksPath, "utf8"), { code: "ENOENT" });
});
