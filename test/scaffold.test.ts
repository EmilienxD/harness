import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScaffoldState, scaffoldProject } from "../src/scaffold/project.js";

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
  for (const name of ["raw", "manager", "explorer"]) await assert.rejects(readFile(join(root, ".claude", "agents", `${name}.md`)));
  assert.deepEqual(report.warnings, ["Missing upstream vendored skill: lavish"]);
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
  const target = join(root, ".claude", "agents", "reviewer.md");
  await writeFile(target, "local edit\n");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: assets, todo, autoCompactEnabled: false });
  assert.equal(await readFile(target, "utf8"), "local edit\n");
  assert.ok(report.preserved.includes(".claude/agents/reviewer.md"));
  assert.ok(report.warnings.some((warning) => warning.includes("autoCompact")));
});

test("unchanged owned files upgrade and vendored files are replaced wholesale", async () => {
  const root = await project(); const source = await project();
  await mkdir(join(source, ".claude", "agents"), { recursive: true }); await mkdir(join(source, ".claude", "hooks"), { recursive: true }); await mkdir(join(source, ".claude", "skills", "commit"), { recursive: true });
  await writeFile(join(source, ".claude", "agents", "reviewer.md"), "v1");
  await writeFile(join(source, ".claude", "skills", "commit", "SKILL.md"), "vendor-v1");
  await writeFile(join(source, ".claude", "hooks", "aboard-hooks.json"), "{}");
  await scaffoldProject({ projectRoot: root, assetRoot: source, todo });
  await writeFile(join(source, ".claude", "agents", "reviewer.md"), "v2");
  await writeFile(join(source, ".claude", "skills", "commit", "SKILL.md"), "vendor-v2");
  await writeFile(join(root, ".claude", "skills", "commit", "SKILL.md"), "local vendor edit");
  const report = await scaffoldProject({ projectRoot: root, assetRoot: source, todo });
  assert.equal(await readFile(join(root, ".claude", "agents", "reviewer.md"), "utf8"), "v2");
  assert.equal(await readFile(join(root, ".claude", "skills", "commit", "SKILL.md"), "utf8"), "vendor-v2");
  assert.ok(report.updated.includes(".claude/agents/reviewer.md"));
});
