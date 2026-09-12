import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LaunchConfiguration } from "../../src/claude/launch.js";

import {
  FileLaunchConfigurationSource,
  LaunchFileError,
  parseLaunchFile,
} from "../../src/platform/launch-configuration.js";

const defaults = `{
  "version": 2,
  "platform": "claude",
  "command": ["claude"],
  "interactive": { "model": "inherit", "effort": "inherit" },
  "explore": { "model": "haiku", "effort": "low" },
  "implementer": { "model": "by-difficulty", "effort": "by-difficulty" },
  "reviewer": { "model": "by-difficulty", "effort": "by-difficulty" }
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
      deniedTools: [],
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
      skillName: "address-this",
      declaredCommand: ["claude"],
      declaredModel: "by-difficulty",
      declaredEffort: "by-difficulty",
      deniedTools: [],
    },
  });
  const reviewer = parsed.value.configuration("reviewer");
  const reviewerSettings = settings(reviewer);
  assert.equal(reviewerSettings.shape, "skill");
  if (reviewerSettings.shape !== "skill") assert.fail("reviewer must resolve to a skill launch");
  assert.equal(reviewerSettings.skillName, "review-this");
});

test("manual delegation identities reuse the unrestricted interactive profile", () => {
  const parsed = parseLaunchFile(defaults);

  for (const type of ["Prototype", "Brainstorm", "General"] as const) {
    assert.deepEqual(parsed.value.configuration(type), {
      platform: "claude",
      settings: {
        shape: "default",
        declaredCommand: ["claude"],
        deniedTools: [],
      },
    });
  }
  assert.deepEqual(parsed.value.configuration("Web Search"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["claude"],
      deniedTools: [],
    },
  });
});

test("Claude preserves user-configured tool denials for every manual identity", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "claude",
    "interactive": { "deniedTools": ["Agent", "WebSearch", "WebFetch"] }
  }`);

  for (const type of ["interactive", "Prototype", "Web Search", "Brainstorm", "General"] as const) {
    assert.deepEqual(settings(parsed.value.configuration(type)).deniedTools, ["Agent", "WebSearch", "WebFetch"]);
  }
});

test("launch.json selects an attended ChatGPT session with its Codex command", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "chatgpt",
    "command": ["wrapper", "codex"],
    "interactive": { "model": "inherit", "effort": "inherit" }
  }`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configuration("interactive"), {
    platform: "chatgpt",
    settings: {
      shape: "default",
      declaredCommand: ["wrapper", "codex"],
    },
  });
});

test("launch.json selects a read-only ChatGPT Explore session and still refuses unsupported kinds", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "chatgpt",
    "command": ["codex"],
    "explore": { "model": "gpt-test", "effort": "low" }
  }`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configuration("Explore"), {
    platform: "chatgpt",
    settings: {
      shape: "explore",
      declaredCommand: ["codex"],
      declaredModel: "gpt-test",
      declaredEffort: "low",
    },
  });
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","explore":{"model":"opus"}}'),
    /explore\.model is not valid for platform chatgpt.*Claude model/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","explore":{"effort":"max"}}'),
    /explore\.effort is not valid for platform chatgpt/u,
  );
});

test("launch.json routes a ChatGPT implementer without overriding native tool settings", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "chatgpt",
    "command": ["codex"]
  }`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configuration("implementer"), {
    platform: "chatgpt",
    settings: {
      shape: "skill",
      skillName: "address-this",
      declaredCommand: ["codex"],
      declaredModel: "by-difficulty",
      declaredEffort: "by-difficulty",
    },
  });
});

test("launch.json routes ChatGPT reviewers through the review skill their disposition selects", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "chatgpt",
    "command": ["codex"],
    "reviewer": { "effort": "high" }
  }`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(settings(parsed.value.configuration("reviewer")), {
    shape: "skill",
    skillName: "review-this",
    declaredCommand: ["codex"],
    declaredModel: "by-difficulty",
    declaredEffort: "high",
  });
  // AFK and HITL are orchestration modes, so both resolve to the one skill.
  const implementer = settings(parsed.value.configuration("implementer"));
  assert.equal(implementer.shape === "skill" ? implementer.skillName : undefined, "address-this");
});

test("a ChatGPT implementer profile is configurable independently of Claude routing", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
    "platform": "chatgpt",
    "implementer": { "model": "gpt-5.6-sol", "effort": "xhigh", "webSearch": "live", "subagents": "allowed" }
  }`);

  assert.deepEqual(settings(parsed.value.configuration("implementer")), {
    shape: "skill",
    skillName: "address-this",
    declaredCommand: ["codex"],
    declaredModel: "gpt-5.6-sol",
    declaredEffort: "xhigh",
    webSearch: "live",
    subagents: "allowed",
  });
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","implementer":{"model":"opus"}}'),
    /implementer\.model is not valid for platform chatgpt.*Claude model/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","implementer":{"effort":"max"}}'),
    /implementer\.effort is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","implementer":{"webSearch":"everything"}}'),
    /implementer\.webSearch is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","interactive":{"webSearch":"live"}}'),
    /interactive\.webSearch is only supported for the implementer and reviewer profiles/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","interactive":{"model":"by-difficulty"}}'),
    /interactive\.model must be inherit or a Codex model slug/u,
  );
});

test("missing profile fields use defaults and unsupported fields produce one warning", () => {
  const parsed = parseLaunchFile(`{
    "version": 2,
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
    '{"version":1,"platform":"claude"}',
    '{"version":2}',
    '{"version":2,"platform":"codex"}',
    '{"version":2,"platform":"claude","command":"claude"}',
    '{"version":2,"platform":"claude","command":[]}',
    '{"version":2,"platform":"claude","interactive":{"model":"by-difficulty"}}',
    '{"version":2,"platform":"claude","explore":{"deniedTools":["Agent"]}}',
    '{"version":2,"platform":"claude","implementer":{"effort":"inherit"}}',
    '{"version":2,"platform":"claude","reviewer":{"deniedTools":"Agent"}}',
    '{"version":2,"platform":"claude","implementer":{"model":"gpt-5.6-sol"}}',
    '{"version":2,"platform":"chatgpt","interactive":{"model":"sonnet"}}',
    '{"version":2,"platform":"claude","stopWaitHours":-1}',
  ]) {
    assert.throws(() => parseLaunchFile(text), LaunchFileError, text);
  }
});

test("the shared stop wait setting is accepted without a platform warning", () => {
  assert.deepEqual(
    parseLaunchFile('{"version":2,"platform":"claude","stopWaitHours":1.5}').diagnostics,
    [],
  );
});

test("platform diagnostics identify missing, unknown, and cross-platform settings", () => {
  assert.throws(() => parseLaunchFile('{"version":2}'), /platform is required.*claude.*chatgpt/u);
  assert.throws(() => parseLaunchFile('{"version":2,"platform":"codex"}'), /platform must be.*claude.*chatgpt.*codex/u);
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"claude","implementer":{"model":"gpt-5.6-sol"}}'),
    /implementer\.model is not valid for platform claude/u,
  );
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"chatgpt","interactive":{"model":"sonnet"}}'),
    /interactive\.model is not valid for platform chatgpt.*Claude model/u,
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

  await writeFile(path, '{"version":2,"platform":"claude","command":[]}', "utf8");
  await assert.rejects(source.get("interactive"), LaunchFileError);
});

test("launch configuration resolves project, then global, then built-in defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-resolution-"));
  const project = join(root, "project", ".harness", "launch.json");
  const global = join(root, "home", ".harness", "launch.json");
  await mkdir(join(root, "home", ".harness"), { recursive: true });
  const source = new FileLaunchConfigurationSource({ project, global });

  assert.equal((await source.load()).value.platform, "claude");
  await writeFile(global, '{"version":2,"platform":"chatgpt","command":["global-codex"]}', "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["global-codex"]);

  await mkdir(join(root, "project", ".harness"), { recursive: true });
  await writeFile(project, '{"version":2,"platform":"claude","command":["project-claude"]}', "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["project-claude"]);
  assert.deepEqual(settings(await source.getFor("chatgpt", "General")).declaredCommand, ["codex"]);
});
