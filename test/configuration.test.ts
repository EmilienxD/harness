import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ABOARD_SETTINGS, createLayeredReader, managerLaunchChanged, parseProjectSettings, readAboardConfiguration } from "../src/configuration.js";

test("configuration validates untrusted values and reports actionable fallbacks", () => {
  const values = new Map<string, unknown>([
    ["aboard.bridge.port", 70_000],
    ["aboard.launch.maxInlinePromptChars", -1],
    ["aboard.manager.toolPreset", "writer"],
    ["aboard.manager.disallowedTools", ["Read", ""]],
    ["aboard.workers.permissionMode", "unsafe"],
    ["aboard.autoRun.scope", "everything"],
    ["aboard.autoRun.review", "yes"],
    ["aboard.timeouts.managerStop", 0],
  ]);
  const result = readAboardConfiguration({ get: (key) => values.get(key) });
  assert.equal(result.value.bridgePort, 4823);
  assert.equal(result.value.maxInlinePromptChars, 4000);
  assert.equal(result.value.managerToolPreset, "read-only");
  assert.deepEqual(result.value.managerDisallowedTools, []);
  assert.equal(result.value.workerPermissionMode, "default");
  assert.deepEqual(result.value.autoRun, { review: false, scope: "spec", pauseAfterHitl: false, mergeStrategy: "squash", pollSeconds: 30 });
  assert.equal(result.value.managerStopTimeoutSeconds, 3600);
  assert.equal(result.diagnostics.length, 8);
  assert.ok(result.diagnostics.every((item) => item.message.includes(item.setting)));
});

test("configuration accepts every supported launch and review setting", () => {
  const values: Record<string, unknown> = {
    "aboard.bridge.port": 0,
    "aboard.launch.maxInlinePromptChars": 12_000,
    "aboard.manager.toolPreset": "delegation-only",
    "aboard.manager.disallowedTools": ["Bash", "Read(./src/**)"],
    "aboard.workers.permissionMode": "bypass",
    "aboard.autoRun.review": true,
    "aboard.autoRun.scope": "all",
    "aboard.autoRun.pauseAfterHitl": true,
    "aboard.autoRun.mergeStrategy": "rebase",
    "aboard.autoRun.pollSeconds": 15,
    "aboard.timeouts.managerStop": 7200,
    "aboard.timeouts.managerPrompt": 45,
    "aboard.timeouts.managerSessionStart": 90,
  };
  const result = readAboardConfiguration({ get: (key) => values[key] });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value.bridgePort, 0);
  assert.equal(result.value.managerToolPreset, "delegation-only");
  assert.deepEqual(result.value.managerDisallowedTools, ["Bash", "Read(./src/**)"]);
  assert.deepEqual(result.value.autoRun, { review: true, scope: "all", pauseAfterHitl: true, mergeStrategy: "rebase", pollSeconds: 15 });
});

test("project settings accept flat, nested, and unprefixed keys", () => {
  const result = parseProjectSettings(JSON.stringify({
    "aboard.workers.permissionMode": "bypass",
    aboard: { timeouts: { managerPrompt: 45 }, manager: { disallowedTools: ["Bash"] } },
    "autoRun.scope": "all",
    "bridge.port": null,
  }));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.fromEntries(result.values), {
    "aboard.workers.permissionMode": "bypass",
    "aboard.timeouts.managerPrompt": 45,
    "aboard.manager.disallowedTools": ["Bash"],
    "aboard.autoRun.scope": "all",
  });
});

test("a malformed or unknown project setting is reported and ignored", () => {
  const broken = parseProjectSettings("{ not json");
  assert.deepEqual([...broken.values.keys()], []);
  assert.deepEqual(broken.diagnostics.map((item) => item.severity), ["error"]);
  assert.deepEqual(parseProjectSettings("[1]").diagnostics.map((item) => item.severity), ["error"]);

  const unknown = parseProjectSettings(JSON.stringify({ "aboard.bridge.prot": 1, "aboard.bridge.port": 5000 }));
  assert.deepEqual(Object.fromEntries(unknown.values), { "aboard.bridge.port": 5000 });
  assert.equal(unknown.diagnostics.length, 1);
  assert.ok(unknown.diagnostics[0]?.message.includes("aboard.bridge.prot"));
});

test("a bad project value falls back exactly like a bad vs code value", () => {
  const project = parseProjectSettings(JSON.stringify({ "aboard.bridge.port": 70_000 }));
  const result = readAboardConfiguration(createLayeredReader({ user: { get: () => undefined }, project: project.values }));
  assert.equal(result.value.bridgePort, 4823);
  assert.deepEqual(result.diagnostics.map((item) => item.setting), ["aboard.bridge.port"]);
});

test("project settings override globals, and an explicit vs code workspace value overrides both", () => {
  const user = new Map<string, unknown>([["aboard.bridge.port", 6000], ["aboard.autoRun.scope", "all"], ["aboard.manager.toolPreset", "delegation-only"]]);
  const workspaceScope = new Map<string, unknown>([["aboard.bridge.port", 7000]]);
  const project = parseProjectSettings(JSON.stringify({ "aboard.bridge.port": 8000, "aboard.autoRun.scope": "spec" }));
  const reader = createLayeredReader({
    user: { get: (key) => user.get(key) },
    workspace: { get: (key) => workspaceScope.get(key) },
    project: project.values,
  });
  const result = readAboardConfiguration(reader);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value.bridgePort, 7000, "an explicit .vscode value wins");
  assert.equal(result.value.autoRun.scope, "spec", "the project file wins over a global");
  assert.equal(result.value.managerToolPreset, "delegation-only", "an unoverridden global still applies");
  assert.equal(result.value.workerPermissionMode, "default", "an unset setting keeps its default");
});

test("manager launch changes are detected by value for the project settings reload path", () => {
  const read = (values: Record<string, unknown>) => readAboardConfiguration({ get: (key) => values[key] }).value;
  const base = read({});
  assert.equal(managerLaunchChanged(base, read({})), false);
  assert.equal(managerLaunchChanged(base, read({ "aboard.manager.toolPreset": "delegation-only" })), true);
  assert.equal(managerLaunchChanged(base, read({ "aboard.launch.claudeCommand": "openclaude" })), true);
  assert.equal(managerLaunchChanged(base, read({ "aboard.manager.disallowedTools": ["Bash"] })), true);
  assert.equal(managerLaunchChanged(base, read({ "aboard.autoRun.scope": "all" })), false);
});

test("every contributed setting is listed in ABOARD_SETTINGS", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, unknown> } } };
  assert.deepEqual([...ABOARD_SETTINGS].sort(), Object.keys(manifest.contributes.configuration.properties).sort());
});

test("the claude command setting accepts a wrapper, and a broken one falls back to claude", () => {
  const read = (value: unknown) => readAboardConfiguration({ get: (key) => key === "aboard.launch.claudeCommand" ? value : undefined });
  assert.deepEqual(read(undefined).value.claudeCommand, ["claude"]);
  assert.deepEqual(read("openclaude").value.claudeCommand, ["openclaude"]);
  assert.deepEqual(read("clauder run kiro --").value.claudeCommand, ["clauder", "run", "kiro", "--"]);
  assert.deepEqual(read(["clauder", "run", "kiro", "--"]).value.claudeCommand, ["clauder", "run", "kiro", "--"]);
  const broken = read('"unterminated');
  assert.deepEqual(broken.value.claudeCommand, ["claude"]);
  assert.deepEqual(broken.diagnostics.map((item) => item.setting), ["aboard.launch.claudeCommand"]);
});

