import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ABOARD_SETTINGS, createLayeredReader, managerLaunchChanged, parseProjectSettings, readAboardConfiguration } from "../src/configuration.js";

test("configuration validates untrusted values and reports actionable fallbacks", () => {
  const values = new Map<string, unknown>([
    ["aboard.bridge.port", 70_000],
    ["aboard.launch.maxInlinePromptChars", -1],
    ["aboard.manager.disallowedTools", ["Read", ""]],
    ["aboard.autoRun.mergeStrategy", "cherry-pick"],
    ["aboard.autoRun.review", "yes"],
    ["aboard.autoRun.branchMode", "one"],
    ["aboard.autoRun.exploreBeforeImplement", "yes"],
    ["aboard.autoRun.recursiveIssueReferences", "yes"],
    ["aboard.autoRun.prompt", 42],
    ["aboard.autoRun.discardBehavior", "delete-everything"],
    ["aboard.timeouts.managerStop", 0],
  ]);
  const result = readAboardConfiguration({ get: (key) => values.get(key) });
  assert.equal(result.value.bridgePort, 4823);
  assert.equal(result.value.maxInlinePromptChars, 4000);
  assert.deepEqual(result.value.managerDisallowedTools, []);
  // Discard falls back to the conservative behavior, not to the destructive one
  // an unrecognised value happens to look like.
  assert.deepEqual(result.value.autoRun, { branchMode: "per-issue", review: false, exploreBeforeImplement: false, recursiveIssueReferences: false, permanentPrompt: "", pauseAfterHitl: false, mergeStrategy: "squash", mergeRunPullRequest: false, pollSeconds: 30, discardBehavior: "record-only", worktree: { enabled: false, root: "", keep: false, setupTimeoutSeconds: 600 } });
  assert.equal(result.value.managerStopTimeoutSeconds, 3600);
  assert.equal(result.diagnostics.length, 11);
  assert.ok(result.diagnostics.every((item) => item.message.includes(item.setting)));
});

test("configuration accepts every supported launch and review setting", () => {
  const values: Record<string, unknown> = {
    "aboard.bridge.port": 0,
    "aboard.launch.maxInlinePromptChars": 12_000,
    "aboard.manager.disallowedTools": ["Bash", "Read(./src/**)"],
    "aboard.autoRun.review": true,
    "aboard.autoRun.branchMode": "single-branch",
    "aboard.autoRun.exploreBeforeImplement": true,
    "aboard.autoRun.recursiveIssueReferences": true,
    "aboard.autoRun.prompt": "  run browser tests  ",
    "aboard.autoRun.pauseAfterHitl": true,
    "aboard.autoRun.mergeStrategy": "rebase",
    "aboard.autoRun.mergeRunPullRequest": true,
    "aboard.autoRun.pollSeconds": 15,
    "aboard.autoRun.discardBehavior": "full-cleanup",
    "aboard.autoRun.worktree.enabled": true,
    "aboard.autoRun.worktree.root": "  ../checkouts  ",
    "aboard.autoRun.worktree.keep": true,
    "aboard.autoRun.worktree.setupTimeoutSeconds": 900,
    "aboard.timeouts.managerStop": 7200,
    "aboard.timeouts.managerPrompt": 45,
    "aboard.timeouts.managerSessionStart": 90,
  };
  const result = readAboardConfiguration({ get: (key) => values[key] });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value.bridgePort, 0);
  assert.deepEqual(result.value.managerDisallowedTools, ["Bash", "Read(./src/**)"]);
  assert.deepEqual(result.value.autoRun, {
    branchMode: "single-branch", review: true, exploreBeforeImplement: true, recursiveIssueReferences: true, permanentPrompt: "run browser tests", pauseAfterHitl: true, mergeStrategy: "rebase", mergeRunPullRequest: true, pollSeconds: 15,
    discardBehavior: "full-cleanup",
    // The root is trimmed: it becomes a path, and a stray space in a settings
    // file would produce a directory nobody meant to create.
    worktree: { enabled: true, root: "../checkouts", keep: true, setupTimeoutSeconds: 900 },
  });
});

test("project settings accept flat, nested, and unprefixed keys", () => {
  const result = parseProjectSettings(JSON.stringify({
    "aboard.launch.maxInlinePromptChars": 6000,
    aboard: { timeouts: { managerPrompt: 45 }, manager: { disallowedTools: ["Bash"] } },
    "autoRun.mergeStrategy": "rebase",
    "bridge.port": null,
  }));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.fromEntries(result.values), {
    "aboard.launch.maxInlinePromptChars": 6000,
    "aboard.timeouts.managerPrompt": 45,
    "aboard.manager.disallowedTools": ["Bash"],
    "aboard.autoRun.mergeStrategy": "rebase",
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
  const user = new Map<string, unknown>([["aboard.bridge.port", 6000], ["aboard.autoRun.mergeStrategy", "rebase"], ["aboard.manager.disallowedTools", ["Bash"]]]);
  const workspaceScope = new Map<string, unknown>([["aboard.bridge.port", 7000]]);
  const project = parseProjectSettings(JSON.stringify({ "aboard.bridge.port": 8000, "aboard.autoRun.mergeStrategy": "merge" }));
  const reader = createLayeredReader({
    user: { get: (key) => user.get(key) },
    workspace: { get: (key) => workspaceScope.get(key) },
    project: project.values,
  });
  const result = readAboardConfiguration(reader);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value.bridgePort, 7000, "an explicit .vscode value wins");
  assert.equal(result.value.autoRun.mergeStrategy, "merge", "the project file wins over a global");
  assert.deepEqual(result.value.managerDisallowedTools, ["Bash"], "an unoverridden global still applies");
});

test("manager launch changes are detected by value for the project settings reload path", () => {
  const read = (values: Record<string, unknown>) => readAboardConfiguration({ get: (key) => values[key] }).value;
  const base = read({});
  assert.equal(managerLaunchChanged(base, read({})), false);
  assert.equal(managerLaunchChanged(base, read({ "aboard.launch.claudeCommand": "openclaude" })), true);
  assert.equal(managerLaunchChanged(base, read({ "aboard.manager.disallowedTools": ["Bash"] })), true);
  assert.equal(managerLaunchChanged(base, read({ "aboard.autoRun.mergeStrategy": "rebase" })), false);
});

test("the launch effort setting accepts every level, and inherit means no flag", () => {
  const read = (value: unknown) => readAboardConfiguration({ get: (key) => key === "aboard.launch.effort" ? value : undefined });
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const result = read(level);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.value.launchEffort, level);
  }
  // Unset and the explicit default both mean "inherit the session level", which
  // is an absent value rather than a level aboard passes on the command line.
  assert.equal(read(undefined).value.launchEffort, undefined);
  assert.deepEqual(read("inherit").diagnostics, []);
  assert.equal(read("inherit").value.launchEffort, undefined);

  const broken = read("ultracode");
  assert.equal(broken.value.launchEffort, undefined);
  assert.deepEqual(broken.diagnostics.map((item) => item.setting), ["aboard.launch.effort"]);

  // Changing it changes the Manager's command line, so the reload path has to
  // offer the restart that applies it.
  const level = (value: unknown) => readAboardConfiguration({ get: (key) => key === "aboard.launch.effort" ? value : undefined }).value;
  assert.equal(managerLaunchChanged(level(undefined), level("high")), true);
  assert.equal(managerLaunchChanged(level("high"), level("high")), false);
});

test("a dead session leaves the terminal alone unless the user opts in", () => {
  const empty = readAboardConfiguration({ get: () => undefined });
  assert.equal(empty.value.closeTerminalOnSessionEnd, false);
  assert.deepEqual(empty.diagnostics, []);

  const opted = readAboardConfiguration({ get: (key) => (key === "aboard.terminals.closeOnSessionEnd" ? true : undefined) });
  assert.equal(opted.value.closeTerminalOnSessionEnd, true);

  const wrong = readAboardConfiguration({ get: (key) => (key === "aboard.terminals.closeOnSessionEnd" ? "always" : undefined) });
  assert.equal(wrong.value.closeTerminalOnSessionEnd, false);
  assert.equal(wrong.diagnostics.length, 1);
});

test("every contributed setting is listed in ABOARD_SETTINGS", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, unknown> } } };
  assert.deepEqual([...ABOARD_SETTINGS].sort(), Object.keys(manifest.contributes.configuration.properties).sort());
});

test("the claude command setting accepts a wrapper, and a broken one falls back to claude", () => {
  const read = (value: unknown) => readAboardConfiguration({ get: (key) => key === "aboard.launch.claudeCommand" ? value : undefined });
  assert.deepEqual(read(undefined).value.claudeCommand, ["claude"]);
  assert.deepEqual(read("openclaude").value.claudeCommand, ["openclaude"]);
  assert.deepEqual(read("wrapper run MyProfile --").value.claudeCommand, ["wrapper", "run", "MyProfile", "--"]);
  assert.deepEqual(read(["wrapper", "run", "MyProfile", "--"]).value.claudeCommand, ["wrapper", "run", "MyProfile", "--"]);
  const broken = read('"unterminated');
  assert.deepEqual(broken.value.claudeCommand, ["claude"]);
  assert.deepEqual(broken.diagnostics.map((item) => item.setting), ["aboard.launch.claudeCommand"]);
});
