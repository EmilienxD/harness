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

test("fresh scaffold installs real assets, runtime ignore rules, hooks, and no forbidden files", async () => {
  const root = await project();
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  assert.equal(report.todo, "existing");
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /^\.aboard\/runtime\/$/m);
  // The Manager's delegation surface is a script, not a registered MCP server:
  // a `.mcp.json` entry loads into every session in the workspace, the user's
  // own included, where it competes with their servers and spends context on
  // tools only the Manager can use.
  assert.match(await readFile(join(root, ".aboard", "scripts", "aboard_cli.py"), "utf8"), /\/cli\/agent/);
  await assert.rejects(readFile(join(root, ".mcp.json")));
  assert.equal((await json(join(root, ".claude", "settings.json"))).hooks !== undefined, true);
  await assert.rejects(readFile(join(root, "TODO.md")));
  // CLAUDE.md is the user's file: aboard's Manager persona ships as an agent
  // definition instead, so no scaffolded instruction applies to every session.
  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  // Definitions land outside `.claude/`, where Claude Code does not scan for
  // subagents: a file there would make every session in the workspace — a raw
  // aboard terminal, the user's own `claude` — able to spawn aboard's agents
  // behind the bridge and outside the write lease.
  assert.match(await readFile(join(root, ".aboard", "agents", "manager.md"), "utf8"), /name: manager/);
  await assert.rejects(readFile(join(root, ".claude", "agents", "manager.md")));
  for (const name of ["raw", "explorer"]) await assert.rejects(readFile(join(root, ".aboard", "agents", `${name}.md`)));
  // User-owned skills are never shipped as assets; without an installer every
  // one is reported instead of being written here.
  for (const skill of VENDORED_SKILLS) {
    await assert.rejects(readFile(join(root, ".claude", "skills", skill.name, "SKILL.md")));
    assert.ok(report.warnings.includes(`Cannot install vendored skill ${skill.name}: no installer available`));
  }
  assert.deepEqual(report.installed, []);
  // Nothing to approve, so nothing is written: a project with no local settings
  // file does not gain one.
  await assert.rejects(readFile(join(root, ".claude", "settings.local.json")));
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

// An upgrade from a version that registered the bridge as an MCP server: the
// stale entry would leave every session in the project pointing at a route the
// bridge no longer serves, so it is removed rather than merely not rewritten.
test("upgrading retires the bridge's own MCP registration and approval, and nothing else", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["memory", "aboard"], permissions: { allow: ["Read"] } }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ custom: 7, mcpServers: { other: { command: "other" }, aboard: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });

  const local = await json(join(root, ".claude", "settings.local.json"));
  assert.deepEqual(local.enabledMcpjsonServers, ["memory"]);
  assert.deepEqual(local.permissions, { allow: ["Read"] });
  const mcp = await json(join(root, ".mcp.json"));
  assert.equal(mcp.custom, 7);
  assert.deepEqual(mcp.mcpServers, { other: { command: "other" } });
});

// The one aboard created and that now holds nothing goes away entirely: a
// project that never had a `.mcp.json` must not be left with an empty one.
test("upgrading removes a .mcp.json that held only the bridge", async () => {
  const root = await project();
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { aboard: { type: "http" } } }));
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["aboard"] }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  await assert.rejects(readFile(join(root, ".mcp.json")));
  assert.deepEqual(await json(join(root, ".claude", "settings.local.json")), {});
});

test("rerun is idempotent and settings merges preserve unrelated configuration", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  const customHook = { matcher: "Write", hooks: [{ type: "command", command: "custom-hook" }] };
  await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, autoCompact: true, hooks: { PostToolUse: [customHook] } }));
  const userMcp = JSON.stringify({ custom: 7, mcpServers: { other: { command: "other" } } });
  await writeFile(join(root, ".mcp.json"), userMcp);
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  const firstSettings = await readFile(join(root, ".claude", "settings.json"), "utf8");
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  assert.equal(await readFile(join(root, ".claude", "settings.json"), "utf8"), firstSettings);
  // A file with no aboard entry in it is not touched at all, formatting included.
  assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), userMcp);
  const settings = await json(join(root, ".claude", "settings.json"));
  assert.deepEqual(settings.permissions, { allow: ["Read"] }); assert.equal(settings.autoCompact, true);
  assert.match(JSON.stringify(settings), /custom-hook/);
});

test("owned assets upgrade only when unchanged and warn rather than clobber local edits", async () => {
  const root = await project();
  await scaffoldProject({ projectRoot: root, assetRoot: assets, todo });
  const target = join(root, ".aboard", "agents", "implementer.md");
  await writeFile(target, "local edit\n");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, todo, autoCompactEnabled: false });
  assert.equal(await readFile(target, "utf8"), "local edit\n");
  assert.ok(report.preserved.includes(".aboard/agents/implementer.md"));
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
  await mkdir(join(source, ".aboard", "agents"), { recursive: true }); await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v1");
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v2");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });
  assert.equal(await readFile(join(root, ".aboard", "agents", "implementer.md"), "utf8"), "v2");
  assert.ok(report.updated.includes(".aboard/agents/implementer.md"));
});

test("vendored skills are installed by command and failures are reported, not authored around", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: Array<{ command: string; cwd: string }> = [];
  const installer = {
    run: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      if (command === "install unreliable") throw new Error("upstream unavailable");
    },
  };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, todo, installer,
    vendoredSkills: [{ name: "commit", command: "install commit" }, { name: "unreliable", command: "install unreliable" }, { name: "grill-me", command: null }],
  });

  assert.deepEqual(calls, [{ command: "install commit", cwd: root }, { command: "install unreliable", cwd: root }]);
  assert.deepEqual(report.installed, ["commit"]);
  assert.ok(report.warnings.includes("Failed to install vendored skill unreliable: upstream unavailable"));
  assert.ok(report.warnings.includes("No install command configured for vendored skill: grill-me"));
  // aboard writes nothing under a vendored skill: the command owns that directory.
  assert.deepEqual(report.created.filter((path) => path.startsWith(".claude/skills/")), []);
});

test("every vendored skill names a runnable install command", () => {
  for (const skill of VENDORED_SKILLS) {
    assert.notEqual(skill.command, null, `${skill.name} has no install command`);
    assert.match(skill.command ?? "", /^(uvx|npx) /u);
  }
  // The issue skills all come from one upstream tool, so each must be listed by
  // name — that is what marks its directory as the user's — and all must agree
  // on the single command that installs them.
  const issues = VENDORED_SKILLS.filter((skill) => (skill.command ?? "").endsWith(" issues"));
  assert.deepEqual(issues.map((skill) => skill.name).sort(), [
    "draft-issue", "draft-issues", "map-issues", "publish-issue", "publish-issues", "to-spec", "to-spec-draft-issue",
  ]);
  // Names must not collide as path prefixes: `.claude/skills/draft-issues/` is a
  // different skill's directory from `draft-issue`'s.
  assert.equal(new Set(VENDORED_SKILLS.map((skill) => skill.name)).size, VENDORED_SKILLS.length);
});

test("skills sharing one upstream tool install with a single command run", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: string[] = [];
  const installer = { run: async (command: string) => { calls.push(command); } };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, todo, installer,
    vendoredSkills: [
      { name: "map-issues", command: "install issues" },
      { name: "draft-issues", command: "install issues" },
      { name: "commit", command: "install commit" },
    ],
  });

  assert.deepEqual(calls, ["install issues", "install commit"]);
  assert.deepEqual(report.installed, ["map-issues", "draft-issues", "commit"]);
  assert.deepEqual(report.warnings.filter((warning) => warning.includes("vendored skill")), []);
});

test("a shared install command that fails is reported once per skill it owns", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: string[] = [];
  const installer = { run: async (command: string) => { calls.push(command); throw new Error("uvx not found"); } };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, todo, installer,
    vendoredSkills: [
      { name: "map-issues", command: "install issues" },
      { name: "publish-issues", command: "install issues" },
    ],
  });

  assert.deepEqual(calls, ["install issues"]);
  assert.deepEqual(report.installed, []);
  assert.ok(report.warnings.includes("Failed to install vendored skill map-issues: uvx not found"));
  assert.ok(report.warnings.includes("Failed to install vendored skill publish-issues: uvx not found"));
});

test("a skill name that prefixes a vendored one is matched by segment, not by prefix", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await mkdir(join(source, ".claude", "skills", "draft-issues"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, ".claude", "skills", "draft-issues", "SKILL.md"), "shipped copy");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo, vendoredSkills: [] });

  await rm(join(source, ".claude", "skills", "draft-issues"), { recursive: true });
  // `draft-issue` is vendored; `draft-issues` is a different skill and must not
  // be shielded by its neighbour's name.
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, todo,
    vendoredSkills: [{ name: "draft-issue", command: null }],
  });
  assert.deepEqual(report.removed, [".claude/skills/draft-issues/SKILL.md"]);
  await assert.rejects(readFile(join(root, ".claude", "skills", "draft-issues", "SKILL.md")));
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
