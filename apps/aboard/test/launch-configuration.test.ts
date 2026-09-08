import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileLaunchConfigurationSource,
  LaunchFileError,
  parseLaunchFile,
} from "../src/claude/launch-configuration.js";

const defaults = `{
  "version": 1,
  "command": ["claude"],
  "interactive": { "model": "inherit", "effort": "inherit", "deniedTools": ["Agent", "WebSearch", "WebFetch"] },
  "explore": { "model": "haiku", "effort": "low" },
  "implementer": { "model": "by-difficulty", "effort": "by-difficulty", "deniedTools": ["Agent", "WebSearch", "WebFetch"] },
  "reviewer": { "model": "by-difficulty", "effort": "by-difficulty", "deniedTools": ["Agent", "WebSearch", "WebFetch"] }
}`;

test("launch.json resolves the four launch profiles", () => {
  const parsed = parseLaunchFile(defaults);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configuration("interactive"), {
    shape: "default",
    declaredCommand: ["claude"],
    deniedTools: ["Agent", "WebSearch", "WebFetch"],
  });
  assert.deepEqual(parsed.value.configuration("Explore"), {
    shape: "builtin",
    agentName: "Explore",
    declaredCommand: ["claude"],
    declaredModel: "haiku",
    declaredEffort: "low",
    deniedTools: [],
  });
  assert.deepEqual(parsed.value.configuration("implementer"), {
    shape: "skill",
    skillName: "implement",
    declaredCommand: ["claude"],
    declaredModel: "by-difficulty",
    declaredEffort: "by-difficulty",
    deniedTools: ["Agent", "WebSearch", "WebFetch"],
  });
  const reviewer = parsed.value.configuration("reviewer", "hitl");
  assert.equal(reviewer.shape, "skill");
  if (reviewer.shape !== "skill") assert.fail("reviewer must resolve to a skill launch");
  assert.equal(reviewer.skillName, "review-hitl");
});

test("missing profile fields use defaults and unsupported fields produce one warning", () => {
  const parsed = parseLaunchFile(`{
    "version": 1,
    "command": ["wrapper", "claude"],
    "interactive": { "deniedTools": [], "future": true },
    "futureRoot": true
  }`);

  assert.deepEqual(parsed.value.configuration("interactive"), {
    shape: "default",
    declaredCommand: ["wrapper", "claude"],
    deniedTools: [],
  });
  assert.equal(parsed.diagnostics.length, 1);
  assert.match(parsed.diagnostics[0]!.message, /futureRoot/u);
  assert.match(parsed.diagnostics[0]!.message, /interactive\.future/u);
});

test("invalid known launch fields block configuration", () => {
  for (const text of [
    "not json",
    "[]",
    '{"version":2}',
    '{"version":1,"command":"claude"}',
    '{"version":1,"command":[]}',
    '{"version":1,"interactive":{"model":"by-difficulty"}}',
    '{"version":1,"explore":{"deniedTools":["Agent"]}}',
    '{"version":1,"implementer":{"effort":"inherit"}}',
    '{"version":1,"reviewer":{"deniedTools":"Agent"}}',
  ]) {
    assert.throws(() => parseLaunchFile(text), LaunchFileError, text);
  }
});

test("the file source reads the latest valid launch.json on every launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-file-"));
  const path = join(root, "launch.json");
  const source = new FileLaunchConfigurationSource(path);
  await writeFile(path, defaults, "utf8");
  assert.deepEqual((await source.get("interactive")).declaredCommand, ["claude"]);

  await writeFile(path, defaults.replace('["claude"]', '["wrapper", "claude"]'), "utf8");
  assert.deepEqual((await source.get("interactive")).declaredCommand, ["wrapper", "claude"]);

  await writeFile(path, '{"version":1,"command":[]}', "utf8");
  await assert.rejects(source.get("interactive"), LaunchFileError);
});
