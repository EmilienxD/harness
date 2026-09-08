import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LaunchConfiguration } from "../src/claude/launch.js";

import {
  FileLaunchConfigurationSource,
  LaunchFileError,
  parseLaunchFile,
} from "../src/platform/launch-configuration.js";

const defaults = `{
  "version": 1,
  "platform": "claude",
  "command": ["claude"],
  "interactive": { "model": "inherit", "effort": "inherit", "deniedTools": ["Agent", "WebSearch", "WebFetch"] },
  "explore": { "model": "haiku", "effort": "low" },
  "implementer": { "model": "by-difficulty", "effort": "by-difficulty", "deniedTools": ["Agent", "WebSearch", "WebFetch"] },
  "reviewer": { "model": "by-difficulty", "effort": "by-difficulty", "deniedTools": ["Agent", "WebSearch", "WebFetch"] }
}`;

function settings(value: { readonly settings: unknown }): LaunchConfiguration {
  return value.settings as LaunchConfiguration;
}

test("launch.json resolves the four launch profiles", () => {
  const parsed = parseLaunchFile(defaults);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configuration("interactive"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["claude"],
      deniedTools: ["Agent", "WebSearch", "WebFetch"],
    },
  });
  assert.deepEqual(parsed.value.configuration("Explore"), {
    platform: "claude",
    settings: {
      shape: "builtin",
      agentName: "Explore",
      declaredCommand: ["claude"],
      declaredModel: "haiku",
      declaredEffort: "low",
      deniedTools: [],
    },
  });
  assert.deepEqual(parsed.value.configuration("implementer"), {
    platform: "claude",
    settings: {
      shape: "skill",
      skillName: "implement",
      declaredCommand: ["claude"],
      declaredModel: "by-difficulty",
      declaredEffort: "by-difficulty",
      deniedTools: ["Agent", "WebSearch", "WebFetch"],
    },
  });
  const reviewer = parsed.value.configuration("reviewer", "hitl");
  const reviewerSettings = settings(reviewer);
  assert.equal(reviewerSettings.shape, "skill");
  if (reviewerSettings.shape !== "skill") assert.fail("reviewer must resolve to a skill launch");
  assert.equal(reviewerSettings.skillName, "review-hitl");
});

test("missing profile fields use defaults and unsupported fields produce one warning", () => {
  const parsed = parseLaunchFile(`{
    "version": 1,
    "platform": "claude",
    "command": ["wrapper", "claude"],
    "interactive": { "deniedTools": [], "future": true },
    "futureRoot": true
  }`);

  assert.deepEqual(parsed.value.configuration("interactive"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["wrapper", "claude"],
      deniedTools: [],
    },
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
    '{"version":1}',
    '{"version":1,"platform":"codex"}',
    '{"version":1,"platform":"claude","command":"claude"}',
    '{"version":1,"platform":"claude","command":[]}',
    '{"version":1,"platform":"claude","interactive":{"model":"by-difficulty"}}',
    '{"version":1,"platform":"claude","explore":{"deniedTools":["Agent"]}}',
    '{"version":1,"platform":"claude","implementer":{"effort":"inherit"}}',
    '{"version":1,"platform":"claude","reviewer":{"deniedTools":"Agent"}}',
    '{"version":1,"platform":"claude","implementer":{"model":"gpt-5.6"}}',
  ]) {
    assert.throws(() => parseLaunchFile(text), LaunchFileError, text);
  }
});

test("platform diagnostics identify missing, unknown, and cross-platform settings", () => {
  assert.throws(() => parseLaunchFile('{"version":1}'), /platform is required.*claude/u);
  assert.throws(() => parseLaunchFile('{"version":1,"platform":"codex"}'), /platform must be.*claude.*codex/u);
  assert.throws(
    () => parseLaunchFile('{"version":1,"platform":"claude","implementer":{"model":"gpt-5.6"}}'),
    /implementer\.model is not valid for platform claude/u,
  );
});

test("the file source reads the latest valid launch.json on every launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-file-"));
  const path = join(root, "launch.json");
  const source = new FileLaunchConfigurationSource(path);
  await writeFile(path, defaults, "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["claude"]);

  await writeFile(path, defaults.replace('["claude"]', '["wrapper", "claude"]'), "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["wrapper", "claude"]);

  await writeFile(path, '{"version":1,"platform":"claude","command":[]}', "utf8");
  await assert.rejects(source.get("interactive"), LaunchFileError);
});
