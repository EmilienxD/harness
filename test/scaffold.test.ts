import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldProject, VENDORED_TOOLS } from "../src/scaffold/project.js";

const assets = join(process.cwd(), "assets", "scaffold");

async function project(): Promise<string> { return mkdtemp(join(tmpdir(), "aboard-scaffold-")); }
async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }

test("fresh scaffold installs assets and hooks and registers no project-scoped MCP server", async () => {
  const root = await project();
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets });
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /^\.aboard\/runtime\/$/m);
  await assert.rejects(readFile(join(root, ".aboard", "scripts", "aboard_cli.py")));
  // The aboard MCP server is declared inline in the Manager's per-launch
  // definition, so it reaches that session and no other. A `.mcp.json` entry
  // would be project-scoped: every worker, and the user's own hand-started
  // `claude`, would connect it and pay for its tool descriptions.
  await assert.rejects(readFile(join(root, ".mcp.json")));
  assert.equal((await json(join(root, ".claude", "settings.json"))).hooks !== undefined, true);
  await assert.rejects(readFile(join(root, "TODO.md")));
  // CLAUDE.md is the user's file: aboard's Manager persona ships as an agent
  // definition instead, so no scaffolded instruction applies to every session.
  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  // Definitions land outside `.claude/`, where Claude Code does not scan for
  // subagents: a file there would make every session in the workspace — an
  // aboard terminal or the user's own `claude` — able to spawn aboard's agents
  // behind the bridge and outside the write lease.
  assert.match(await readFile(join(root, ".aboard", "agents", "manager.md"), "utf8"), /name: manager/);
  const explore = await readFile(join(root, ".aboard", "agents", "Explore.md"), "utf8");
  assert.match(explore, /name: Explore/);
  assert.doesNotMatch(explore, /^tools\s*:/mu);
  await assert.rejects(readFile(join(root, ".claude", "agents", "manager.md")));
  for (const name of ["general-purpose", "explorer"]) await assert.rejects(readFile(join(root, ".aboard", "agents", `${name}.md`)));
  // User-owned skills are never shipped as assets; without an installer every
  // one is reported instead of being written here.
  for (const tool of VENDORED_TOOLS) {
    if (tool.kind === "skill") await assert.rejects(readFile(join(root, ".claude", "skills", tool.name, "SKILL.md")));
    assert.ok(report.warnings.includes(`Cannot install vendored tool ${tool.name}: no installer available`));
  }
  assert.deepEqual(report.installed, []);
  // The scaffolder reaches no GitHub boundary at all: a repository with no
  // `ai:todo` carrier is the normal first-run state, and an empty placeholder
  // issue is worse than none because it looks like a roadmap. The briefing
  // reports the absence as work to do, and `/update-todo` writes the first one.
  assert.equal("todo" in report, false);
  // An existing installation upgrades the same way, with nothing to reconcile.
  assert.equal("todo" in await scaffoldProject({ projectRoot: root, assetRoot: assets }), false);
  await assert.rejects(readFile(join(root, ".claude", "settings.local.json")));
  assert.equal((await json(join(root, ".claude", "settings.json"))).enabledMcpjsonServers, undefined);
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /^\.claude\/settings\.local\.json$/m);
});

test("scaffold state distinguishes a first initialize from a later update", async () => {
  const root = await project();
  assert.equal(await readScaffoldState(root), "uninitialized");
  await mkdir(join(root, ".aboard"), { recursive: true });
  await writeFile(join(root, ".aboard", "scaffold.json"), "not json at all");
  assert.equal(await readScaffoldState(root), "uninitialized");
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  assert.equal(await readScaffoldState(root), "initialized");
});

test("rerun is idempotent and settings merges preserve unrelated configuration", async () => {
  const root = await project();
  await mkdir(join(root, ".claude"), { recursive: true });
  const customHook = { matcher: "Write", hooks: [{ type: "command", command: "custom-hook" }] };
  await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, autoCompact: true, hooks: { PostToolUse: [customHook] } }));
  // An installation from an older aboard, carrying the project-scoped
  // registration this version withdraws — alongside the user's own server and
  // their own approval, both of which must survive untouched.
  await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["memory", "aboard"], permissions: { allow: ["Read"] } }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ custom: 7, mcpServers: { other: { command: "other" }, aboard: { type: "http" } } }));
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  const firstSettings = await readFile(join(root, ".claude", "settings.json"), "utf8");
  await scaffoldProject({ projectRoot: root, assetRoot: assets });
  assert.equal(await readFile(join(root, ".claude", "settings.json"), "utf8"), firstSettings);
  const mcp = await json(join(root, ".mcp.json"));
  assert.equal(mcp.custom, 7);
  assert.deepEqual((mcp.mcpServers as Record<string, unknown>).other, { command: "other" });
  assert.equal((mcp.mcpServers as Record<string, unknown>).aboard, undefined);
  const local = await json(join(root, ".claude", "settings.local.json"));
  assert.deepEqual(local.enabledMcpjsonServers, ["memory"]);
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

test("retires an asset aboard no longer ships unless the user edited it", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, "CLAUDE.md"), "manager persona");
  await writeFile(join(source, "retired.md"), "retired");
  await scaffoldProject({ projectRoot: root, assetRoot: source });

  await rm(join(source, "CLAUDE.md")); await rm(join(source, "retired.md"));
  await writeFile(join(root, "retired.md"), "the user made this theirs");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source });

  await assert.rejects(readFile(join(root, "CLAUDE.md")));
  assert.deepEqual(report.removed, ["CLAUDE.md"]);
  assert.equal(await readFile(join(root, "retired.md"), "utf8"), "the user made this theirs");
  assert.ok(report.preserved.includes("retired.md"));
  assert.deepEqual(report.warnings.filter((warning) => warning.toLowerCase().includes("preserved")), []);

  // The retirement is recorded, so a third run has nothing left to report.
  const third = await scaffoldProject({ projectRoot: root, assetRoot: source });
  assert.deepEqual(third.removed, []);
  assert.deepEqual(third.preserved, []);
});

test("unchanged owned files upgrade to the shipped version", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".aboard", "agents"), { recursive: true }); await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v1");
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await scaffoldProject({ projectRoot: root, assetRoot: source, vendoredTools: [] });
  await writeFile(join(source, ".aboard", "agents", "implementer.md"), "v2");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, vendoredTools: [] });
  assert.equal(await readFile(join(root, ".aboard", "agents", "implementer.md"), "utf8"), "v2");
  assert.ok(report.updated.includes(".aboard/agents/implementer.md"));
});

test("vendored tools are installed by command and failures are reported, not authored around", async () => {
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
    projectRoot: root, assetRoot: source, installer,
    vendoredTools: [{ name: "commit", kind: "skill", command: "install commit" }, { name: "unreliable", kind: "hooks", command: "install unreliable" }, { name: "grill-me", kind: "skill", command: null }],
  });

  assert.deepEqual(calls, [{ command: "install commit", cwd: root }, { command: "install unreliable", cwd: root }]);
  assert.deepEqual(report.installed, ["commit"]);
  assert.ok(report.warnings.includes("Failed to install vendored tool unreliable: upstream unavailable"));
  assert.ok(report.warnings.includes("No install command configured for vendored tool: grill-me"));
  // aboard writes nothing under a vendored skill: the command owns that directory.
  assert.deepEqual(report.created.filter((path) => path.startsWith(".claude/skills/")), []);
});

test("every vendored tool names a runnable install command", () => {
  for (const tool of VENDORED_TOOLS) {
    assert.notEqual(tool.command, null, `${tool.name} has no install command`);
    assert.match(tool.command ?? "", /^(uvx|npx) /u);
  }
  // The issue skills all come from one upstream tool, so each must be listed by
  // name — that is what marks its directory as the user's — and all must agree
  // on the single command that installs them.
  const issues = VENDORED_TOOLS.filter((tool) => (tool.command ?? "").endsWith(" issues"));
  assert.deepEqual(issues.map((tool) => tool.name).sort(), [
    "draft-issue", "draft-issues", "map-issues", "publish-issue", "publish-issues", "to-spec", "to-spec-draft-issue",
  ]);
  // Names must not collide as path prefixes: `.claude/skills/draft-issues/` is a
  // different skill's directory from `draft-issue`'s.
  assert.equal(new Set(VENDORED_TOOLS.map((tool) => tool.name)).size, VENDORED_TOOLS.length);
  assert.deepEqual(VENDORED_TOOLS.find((tool) => tool.name === "usage-limit-wait"), {
    name: "usage-limit-wait", kind: "hooks", command: "uvx --from git+https://github.com/EmilienxD/harness harness install usage-limit-wait",
  });
});

test("skills sharing one upstream tool install with a single command run", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: string[] = [];
  const installer = { run: async (command: string) => { calls.push(command); } };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, installer,
    vendoredTools: [
      { name: "map-issues", kind: "skill", command: "install issues" },
      { name: "draft-issues", kind: "skill", command: "install issues" },
      { name: "commit", kind: "skill", command: "install commit" },
    ],
  });

  assert.deepEqual(calls, ["install issues", "install commit"]);
  assert.deepEqual(report.installed, ["map-issues", "draft-issues", "commit"]);
  assert.deepEqual(report.warnings.filter((warning) => warning.includes("vendored tool")), []);
});

test("a shared install command that fails is reported once per skill it owns", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  const calls: string[] = [];
  const installer = { run: async (command: string) => { calls.push(command); throw new Error("uvx not found"); } };
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source, installer,
    vendoredTools: [
      { name: "map-issues", kind: "skill", command: "install issues" },
      { name: "publish-issues", kind: "skill", command: "install issues" },
    ],
  });

  assert.deepEqual(calls, ["install issues"]);
  assert.deepEqual(report.installed, []);
  assert.ok(report.warnings.includes("Failed to install vendored tool map-issues: uvx not found"));
  assert.ok(report.warnings.includes("Failed to install vendored tool publish-issues: uvx not found"));
});

test("a skill name that prefixes a vendored one is matched by segment, not by prefix", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true });
  await mkdir(join(source, ".claude", "skills", "draft-issues"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, ".claude", "skills", "draft-issues", "SKILL.md"), "shipped copy");
  await scaffoldProject({ projectRoot: root, assetRoot: source, vendoredTools: [] });

  await rm(join(source, ".claude", "skills", "draft-issues"), { recursive: true });
  // `draft-issue` is vendored; `draft-issues` is a different skill and must not
  // be shielded by its neighbour's name.
  const report = await scaffoldProject({
    projectRoot: root, assetRoot: source,
    vendoredTools: [{ name: "draft-issue", kind: "skill", command: null }],
  });
  assert.deepEqual(report.removed, [".claude/skills/draft-issues/SKILL.md"]);
  await assert.rejects(readFile(join(root, ".claude", "skills", "draft-issues", "SKILL.md")));
});

test("a vendored skill copy from an earlier build is handed back to the user, not retired", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "hooks"), { recursive: true }); await mkdir(join(source, ".claude", "skills", "commit"), { recursive: true });
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await writeFile(join(source, ".claude", "skills", "commit", "SKILL.md"), "shipped copy");
  await scaffoldProject({ projectRoot: root, assetRoot: source, vendoredTools: [] });

  await rm(join(source, ".claude", "skills", "commit"), { recursive: true });
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, vendoredTools: [{ name: "commit", kind: "skill", command: null }] });
  assert.equal(await readFile(join(root, ".claude", "skills", "commit", "SKILL.md"), "utf8"), "shipped copy");
  assert.deepEqual(report.removed, []);
  const manifest = await json(join(root, ".aboard", "scaffold.json"));
  assert.equal(JSON.stringify(manifest).includes("skills/commit"), false);
});
