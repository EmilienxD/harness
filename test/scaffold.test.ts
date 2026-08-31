import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldCatalogRevision, scaffoldProject, type ScaffoldState } from "../src/scaffold/project.js";

const assets = join(process.cwd(), "assets", "scaffold");

async function project(): Promise<string> { return mkdtemp(join(tmpdir(), "aboard-scaffold-")); }
async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
async function state(projectRoot: string, assetRoot: string): Promise<ScaffoldState> {
  return readScaffoldState(projectRoot, await scaffoldCatalogRevision(assetRoot));
}

test("fresh scaffold installs every aboard-owned asset under .aboard only", async () => {
  const root = await project();
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets });
  await assert.rejects(readFile(join(root, ".gitignore")));
  assert.equal(await readFile(join(root, ".aboard", ".gitignore"), "utf8"), "runtime/\n");
  await assert.rejects(readFile(join(root, ".aboard", "scripts", "aboard_cli.py")));
  await assert.rejects(readFile(join(root, ".mcp.json")));
  await assert.rejects(readFile(join(root, ".claude", "settings.json")));
  assert.equal((await json(join(root, ".aboard", "aboard-hooks.json"))).UserPromptSubmit !== undefined, true);
  assert.match(await readFile(join(root, ".aboard", "scripts", "aboard_hook.py"), "utf8"), /ABOARD_AGENT_ID/u);
  assert.match(await readFile(join(root, ".aboard", "skills", "brainstorm", "SKILL.md"), "utf8"), /brainstorm/u);
  await assert.rejects(readFile(join(root, "TODO.md")));
  // CLAUDE.md is the user's file: aboard's Manager persona ships as an agent
  // definition instead, so no scaffolded instruction applies to every session.
  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  assert.match(await readFile(join(root, ".aboard", "agents", "manager.md"), "utf8"), /name: manager/);
  const explore = await readFile(join(root, ".aboard", "agents", "Explore.md"), "utf8");
  assert.match(explore, /name: Explore/);
  assert.doesNotMatch(explore, /^tools\s*:/mu);
  await assert.rejects(readFile(join(root, ".claude", "agents", "manager.md")));
  for (const name of ["general-purpose", "explorer"]) await assert.rejects(readFile(join(root, ".aboard", "agents", `${name}.md`)));
  assert.equal("todo" in report, false);
  // An existing installation upgrades the same way, with nothing to reconcile.
  assert.equal("todo" in await scaffoldProject({ projectRoot: root, assetRoot: assets }), false);
  await assert.rejects(readFile(join(root, ".claude")));
});

test("scaffold state distinguishes a first initialize from a later update", async () => {
  const root = await project();
  assert.equal(await state(root, assets), "uninitialized");
  await mkdir(join(root, ".aboard"), { recursive: true });
  await writeFile(join(root, ".aboard", "scaffold.json"), "not json at all");
  assert.equal(await state(root, assets), "uninitialized");
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  assert.equal(await state(root, assets), "ready");
});

test("a legacy or changed scaffold requires an explicit update", async () => {
  const root = await project(); const source = await project();
  const sourceAgent = join(source, ".aboard", "agents", "implementer.md");
  await mkdir(dirname(sourceAgent), { recursive: true });
  await writeFile(sourceAgent, "v1");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.equal(await state(root, source), "ready");

  const manifestPath = join(root, ".aboard", "scaffold.json");
  const manifest = await json(manifestPath);
  delete manifest.revision;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.equal(await state(root, source), "update-required");

  await writeFile(sourceAgent, "v2");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  await writeFile(sourceAgent, "v3");
  assert.equal(await state(root, source), "update-required");
});

test("rerun is idempotent and never changes user Claude or MCP configuration", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  const customHook = { matcher: "Write", hooks: [{ type: "command", command: "custom-hook" }] };
  await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, autoCompact: true, hooks: { PostToolUse: [customHook] } }));
  // Every project-wide Claude and MCP value is user-owned, including names
  // that happen to contain "aboard". Initialization leaves them untouched.
  await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["memory", "aboard"], permissions: { allow: ["Read"] } }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ custom: 7, mcpServers: { other: { command: "other" }, aboard: { type: "http" } } }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  const firstSettings = await readFile(join(root, ".claude", "settings.json"), "utf8");
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  assert.equal(await readFile(join(root, ".claude", "settings.json"), "utf8"), firstSettings);
  const mcp = await json(join(root, ".mcp.json"));
  assert.equal(mcp.custom, 7);
  assert.deepEqual((mcp.mcpServers as Record<string, unknown>).other, { command: "other" });
  assert.deepEqual((mcp.mcpServers as Record<string, unknown>).aboard, { type: "http" });
  const local = await json(join(root, ".claude", "settings.local.json"));
  assert.deepEqual(local.enabledMcpjsonServers, ["memory", "aboard"]);
  assert.deepEqual(local.permissions, { allow: ["Read"] });
  const settings = await json(join(root, ".claude", "settings.json"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] }); assert.equal(settings.autoCompact, true);
  assert.match(JSON.stringify(settings), /custom-hook/);
});

test("owned assets upgrade only when unchanged and quietly preserve local edits", async () => {
  const root = await project();
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  const target = join(root, ".aboard", "agents", "implementer.md");
  await writeFile(target, "local edit\n");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, autoCompactEnabled: false });
  assert.equal(await readFile(target, "utf8"), "local edit\n");
  assert.ok(report.preserved.includes(".aboard/agents/implementer.md"));
  // Preserving a local edit is non-destructive and needs no user action, so it
  // is not a warning; the autoCompact check remains the only warning here.
  assert.deepEqual(report.warnings.filter((warning) => warning.toLowerCase().includes("preserved")), []);
  assert.ok(report.warnings.some((warning) => warning.includes("autoCompact")));
});

test("preserving a local edit does not advance its installed-version baseline", async () => {
  const root = await project(); const source = await project();
  const sourceAgent = join(source, ".aboard", "agents", "implementer.md");
  const installedAgent = join(root, ".aboard", "agents", "implementer.md");
  await mkdir(dirname(sourceAgent), { recursive: true });
  await writeFile(sourceAgent, "v1");
  await scaffoldProject({ projectRoot: root, assetRoot: source });

  await writeFile(installedAgent, "local edit");
  await writeFile(sourceAgent, "v2");
  const preserved = await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.ok(preserved.preserved.includes(".aboard/agents/implementer.md"));

  await writeFile(installedAgent, "v1");
  const updated = await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.equal(await readFile(installedAgent, "utf8"), "v2");
  assert.ok(updated.updated.includes(".aboard/agents/implementer.md"));
});

test("a pre-existing conflicting asset is preserved without claiming its source version was installed", async () => {
  const root = await project(); const source = await project();
  const sourceAgent = join(source, ".aboard", "agents", "implementer.md");
  const installedAgent = join(root, ".aboard", "agents", "implementer.md");
  await mkdir(dirname(sourceAgent), { recursive: true });
  await mkdir(dirname(installedAgent), { recursive: true });
  await writeFile(sourceAgent, "shipped");
  await writeFile(installedAgent, "pre-existing");

  const report = await scaffoldProject({ projectRoot: root, assetRoot: source });
  const manifest = await json(join(root, ".aboard", "scaffold.json"));
  assert.ok(report.preserved.includes(".aboard/agents/implementer.md"));
  assert.equal(Object.hasOwn(manifest.assets as object, ".aboard/agents/implementer.md"), false);
});

test("retired owned assets are removed only when they are unchanged", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".aboard", "scripts"), { recursive: true });
  await writeFile(join(source, ".aboard", "scripts", "aboard_hook.py"), "recorded hook");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  await rm(join(source, ".aboard", "scripts", "aboard_hook.py"));
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source });
  await assert.rejects(readFile(join(root, ".aboard", "scripts", "aboard_hook.py")));
  assert.ok(report.removed.includes(".aboard/scripts/aboard_hook.py"));
  const manifest = await json(join(root, ".aboard", "scaffold.json"));
  assert.equal(Object.hasOwn(manifest.assets as object, ".aboard/scripts/aboard_hook.py"), false);
});

test("locally changed retired assets are preserved and relinquished", async () => {
  const root = await project(); const source = await project();
  const sourceHook = join(source, ".aboard", "scripts", "old_hook.py");
  const installedHook = join(root, ".aboard", "scripts", "old_hook.py");
  await mkdir(dirname(sourceHook), { recursive: true });
  await writeFile(sourceHook, "shipped");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  await writeFile(installedHook, "local edit");
  await rm(sourceHook);
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.equal(await readFile(installedHook, "utf8"), "local edit");
  assert.ok(report.preserved.includes(".aboard/scripts/old_hook.py"));
  const manifest = await json(join(root, ".aboard", "scaffold.json"));
  assert.equal(Object.hasOwn(manifest.assets as object, ".aboard/scripts/old_hook.py"), false);
});

test("retired cleanup ignores manifest paths outside .aboard", async () => {
  const root = await project(); const source = await project();
  const sourceAsset = join(source, ".aboard", "owned.txt");
  await mkdir(dirname(sourceAsset), { recursive: true });
  await writeFile(sourceAsset, "owned");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");
  const manifestPath = join(root, ".aboard", "scaffold.json");
  const manifest = await json(manifestPath);
  (manifest.assets as Record<string, unknown>)["../outside.txt"] = {
    sourceHash: "31207c361cda63e8340254ff308c0a170d6dc7d35a07303a2fd0abde6bda225f",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("unchanged owned files upgrade to the shipped version", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".aboard", "agents"), { recursive: true }); await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v1");
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await scaffoldProject({ projectRoot: root, assetRoot: source });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v2");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.equal(await readFile(join(root, ".aboard", "agents", "implementer.md"), "utf8"), "v2");
  assert.ok(report.updated.includes(".aboard/agents/implementer.md"));
});
