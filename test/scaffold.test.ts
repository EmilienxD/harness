import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldProject, VENDORED_SKILLS } from "../src/scaffold/project.js";

const assets = join(process.cwd(), "assets", "scaffold");
const todo = { ensure: async () => "existing" as const };

async function project(): Promise<string> { return mkdtemp(join(tmpdir(), "aboard-scaffold-")); }
async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }

test("fresh scaffold installs real assets, runtime ignore rules, MCP, hooks, and no forbidden files", async () => {
  const root = await project();
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  assert.equal(report.todo, "existing");
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /^\.aboard\/runtime\/$/m);
  assert.equal((await json(join(root, ".mcp.json"))).mcpServers !== undefined, true);
  assert.equal((await json(join(root, ".claude", "settings.json"))).hooks !== undefined, true);
  await assert.rejects(readFile(join(root, "TODO.md")));
  // CLAUDE.md is the user's file: aboard's Manager persona ships as an agent
  // definition instead, so no scaffolded instruction applies to every session.
  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  assert.match(await readFile(join(root, ".claude", "agents", "manager.md"), "utf8"), /name: manager/);
  for (const name of ["raw", "explorer"]) await assert.rejects(readFile(join(root, ".claude", "agents", `${name}.md`)));
  // User-owned skills are never shipped as assets; every one is reported as
  // awaiting its install command instead.
  for (const skill of VENDORED_SKILLS) {
    await assert.rejects(readFile(join(root, ".claude", "skills", skill.name, "SKILL.md")));
    assert.ok(report.warnings.includes(`No install command configured for vendored skill: ${skill.name}`));
  }
  assert.deepEqual(report.installed, []);
  // The MCP approval only takes effect from the uncommitted local settings file.
  assert.deepEqual((await json(join(root, ".claude", "settings.local.json"))).enabledMcpjsonServers, ["aboard"]);
  assert.equal((await json(join(root, ".claude", "settings.json"))).enabledMcpjsonServers, undefined);
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /^\.claude\/settings\.local\.json$/m);
});

test("scaffold state distinguishes a first initialize from a later update", async () => {
  const root = await project();
  assert.equal(await readScaffoldState(root), "uninitialized");
  await mkdir(join(root, ".aboard"), { recursive: true });
  await writeFile(join(root, ".aboard", "scaffold.json"), "not json at all");
  assert.equal(await readScaffoldState(root), "uninitialized");
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  assert.equal(await readScaffoldState(root), "initialized");
});

test("MCP approval merges into existing local settings without duplicating or dropping keys", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["memory"], permissions: { allow: ["Read"] } }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  const local = await json(join(root, ".claude", "settings.local.json"));
  assert.deepEqual(local.enabledMcpjsonServers, ["memory", "aboard"]);
  assert.deepEqual(local.permissions, { allow: ["Read"] });
});

test("rerun is idempotent and settings and MCP merges preserve unrelated configuration", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  const customHook = { matcher: "Write", hooks: [{ type: "command", command: "custom-hook" }] };
  await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, autoCompact: true, hooks: { PostToolUse: [customHook] } }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ custom: 7, mcpServers: { other: { command: "other" } } }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  const firstSettings = await readFile(join(root, ".claude", "settings.json"), "utf8");
  const firstMcp = await readFile(join(root, ".mcp.json"), "utf8");
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  assert.equal(await readFile(join(root, ".claude", "settings.json"), "utf8"), firstSettings);
  assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), firstMcp);
  const settings = await json(join(root, ".claude", "settings.json"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] }); assert.equal(settings.autoCompact, true);
  assert.match(JSON.stringify(settings), /custom-hook/);
  const mcp = await json(join(root, ".mcp.json")); assert.equal(mcp.custom, 7); assert.match(JSON.stringify(mcp), /other/);
});

test("owned assets upgrade only when unchanged and warn rather than clobber local edits", async () => {
  const root = await project();
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  const target = join(root, ".claude", "agents", "implementer.md");
  await writeFile(target, "local edit\n");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, todo, autoCompactEnabled: false });
  assert.equal(await readFile(target, "utf8"), "local edit\n");
  assert.ok(report.preserved.includes(".claude/agents/implementer.md"));
  assert.ok(report.warnings.some((warning) => warning.includes("autoCompact")));
});

test("retires an asset aboard no longer ships unless the user edited it", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, "CLAUDE.md"), "manager persona");
  await writeFile(join(source, "retired.md"), "retired");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo });

  await rm(join(source, "CLAUDE.md")); await rm(join(source, "retired.md"));
  await writeFile(join(root, "retired.md"), "the user made this theirs");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, todo });

  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  assert.deepEqual(report.removed, ["CLAUDE.md"]);
  assert.equal(await readFile(join(root, "retired.md"), "utf8"), "the user made this theirs");
  assert.ok(report.preserved.includes("retired.md"));
  assert.ok(report.warnings.some((warning) => warning.includes("no longer ships: retired.md")));

  // The retirement is recorded, so a third run has nothing left to report.
  const third = await scaffoldProject({ projectRoot: root, assetRoot: source, todo });
  assert.deepEqual(third.removed, []);
  assert.deepEqual(third.preserved, []);
});

test("unchanged owned files upgrade to the shipped version", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "agents"), { recursive: true }); await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "agents", "implementer.md"), "v1");
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });
  await writeFile(join(source, ".claude", "agents", "implementer.md"), "v2");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });
  assert.equal(await readFile(join(root, ".claude", "agents", "implementer.md"), "utf8"), "v2");
  assert.ok(report.updated.includes(".claude/agents/implementer.md"));
});

test("vendored skills are installed by command and failures are reported, not authored around", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: Array<{ command: string; cwd: string }> = [];
  const installer = {
    run: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      if (command === "install lavish") throw new Error("upstream unavailable");
    },
  };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, todo, installer,
    vendoredSkills: [{ name: "commit", command: "install commit" }, { name: "lavish", command: "install lavish" }, { name: "grill-me", command: null }],
  });

  assert.deepEqual(calls, [{ command: "install commit", cwd: root }, { command: "install lavish", cwd: root }]);
  assert.deepEqual(report.installed, ["commit"]);
  assert.ok(report.warnings.includes("Failed to install vendored skill lavish: upstream unavailable"));
  assert.ok(report.warnings.includes("No install command configured for vendored skill: grill-me"));
  // aboard writes nothing under a vendored skill: the command owns that directory.
  assert.deepEqual(report.created.filter((path) => path.startsWith(".claude/skills/")), []);
});

test("a vendored skill copy from an earlier build is handed back to the user, not retired", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true }); await mkdir(join(source, ".claude", "skills", "commit"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, ".claude", "skills", "commit", "SKILL.md"), "shipped copy");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });

  await rm(join(source, ".claude", "skills", "commit"), { recursive: true });
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [{ name: "commit", command: null }] });
  assert.equal(await readFile(join(root, ".claude", "skills", "commit", "SKILL.md"), "utf8"), "shipped copy");
  assert.deepEqual(report.removed, []);
  const manifest = await json(join(root, ".aboard", "scaffold.json"));
  assert.equal(JSON.stringify(manifest).includes("skills/commit"), false);
});
