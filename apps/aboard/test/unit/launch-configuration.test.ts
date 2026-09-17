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
  "version": 1,
  "autoRun": { "provider": "claude" },
  "providers": {
    "claude": {
      "command": ["claude"],
      "interactive": { "model": "inherit", "effort": "inherit" },
      "explore": { "model": "haiku", "effort": "low" },
      "address": { "model": "by-difficulty", "effort": "by-difficulty" },
      "review": { "model": "by-difficulty", "effort": "by-difficulty" }
    },
    "chatgpt": {}
  }
}`;

function settings(value: { readonly settings: unknown }): LaunchConfiguration {
  return value.settings as LaunchConfiguration;
}

function providerFile(provider: "claude" | "chatgpt", value: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, autoRun: { provider }, providers: { claude: {}, chatgpt: {}, [provider]: value } });
}

test("launch.json configures Claude and ChatGPT together while Claude defaults only Auto Run", () => {
  const parsed = parseLaunchFile(`{
    "version": 1,
    "autoRun": { "provider": "claude" },
    "providers": {
      "claude": { "command": ["wrapper", "claude"] },
      "chatgpt": { "command": ["wrapper", "codex"] }
    }
  }`);

  assert.equal(parsed.value.autoRunProvider, "claude");
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "interactive")).declaredCommand, ["wrapper", "claude"]);
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "interactive")).declaredCommand, ["wrapper", "codex"]);
});

test("launch.json resolves the four launch profiles", () => {
  const parsed = parseLaunchFile(defaults);

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configurationFor("claude", "interactive"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["claude"],
      deniedTools: [],
    },
  });
  assert.deepEqual(parsed.value.configurationFor("claude", "Explore"), {
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
  assert.deepEqual(parsed.value.configurationFor("claude", "address"), {
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
  const review = parsed.value.configurationFor("claude", "review");
  const reviewSettings = settings(review);
  assert.equal(reviewSettings.shape, "skill");
  if (reviewSettings.shape !== "skill") assert.fail("review must resolve to a skill launch");
  assert.equal(reviewSettings.skillName, "review-this");
});

test("manual delegation identities reuse the unrestricted interactive profile", () => {
  const parsed = parseLaunchFile(defaults);

  for (const type of ["prototype", "brainstorm", "general"] as const) {
    assert.deepEqual(parsed.value.configurationFor("claude", type), {
      platform: "claude",
      settings: {
        shape: "default",
        declaredCommand: ["claude"],
        deniedTools: [],
      },
    });
  }
  assert.deepEqual(parsed.value.configurationFor("claude", "websearch"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["claude"],
      deniedTools: [],
    },
  });
});

test("Claude preserves user-configured tool denials for every manual identity", () => {
  const parsed = parseLaunchFile(providerFile("claude", { interactive: { deniedTools: ["Agent", "WebSearch", "WebFetch"] } }));

  for (const type of ["interactive", "prototype", "websearch", "brainstorm", "general"] as const) {
    assert.deepEqual(settings(parsed.value.configurationFor("claude", type)).deniedTools, ["Agent", "WebSearch", "WebFetch"]);
  }
});

test("launch.json selects an attended ChatGPT session with its Codex command", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["wrapper", "codex"], interactive: { model: "inherit", effort: "inherit" } }));

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configurationFor("chatgpt", "interactive"), {
    platform: "chatgpt",
    settings: {
      shape: "default",
      declaredCommand: ["wrapper", "codex"],
    },
  });
});

test("launch.json selects a read-only ChatGPT Explore session and still refuses unsupported kinds", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["codex"], explore: { model: "gpt-test", effort: "low" } }));

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configurationFor("chatgpt", "Explore"), {
    platform: "chatgpt",
    settings: {
      shape: "explore",
      declaredCommand: ["codex"],
      declaredModel: "gpt-test",
      declaredEffort: "low",
    },
  });
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { explore: { model: "opus" } })),
    /explore\.model is not valid for platform chatgpt.*Claude model/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { explore: { effort: "max" } })),
    /explore\.effort is not valid for platform chatgpt/u,
  );
});

test("launch.json routes a ChatGPT address without overriding native tool settings", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["codex"] }));

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configurationFor("chatgpt", "address"), {
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

test("launch.json routes ChatGPT review workers through the review skill their disposition selects", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["codex"], review: { effort: "high" } }));

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "review")), {
    shape: "skill",
    skillName: "review-this",
    declaredCommand: ["codex"],
    declaredModel: "by-difficulty",
    declaredEffort: "high",
  });
  // AFK and HITL are orchestration modes, so both resolve to the one skill.
  const address = settings(parsed.value.configurationFor("chatgpt", "address"));
  assert.equal(address.shape === "skill" ? address.skillName : undefined, "address-this");
});

test("a ChatGPT address profile is configurable independently of Claude routing", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { address: { model: "gpt-5.6-sol", effort: "xhigh", webSearch: "live", subagents: "allowed" } }));

  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "address")), {
    shape: "skill",
    skillName: "address-this",
    declaredCommand: ["codex"],
    declaredModel: "gpt-5.6-sol",
    declaredEffort: "xhigh",
    webSearch: "live",
    subagents: "allowed",
  });
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { address: { model: "opus" } })),
    /address\.model is not valid for platform chatgpt.*Claude model/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { address: { effort: "max" } })),
    /address\.effort is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { address: { webSearch: "everything" } })),
    /address\.webSearch is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { webSearch: "live" } })),
    /interactive\.webSearch is only supported for the address and review profiles/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { model: "by-difficulty" } })),
    /interactive\.model must be inherit or a Codex model slug/u,
  );
});

test("missing profile fields use defaults and unsupported fields produce one warning", () => {
  const parsed = parseLaunchFile(JSON.stringify({
    version: 1,
    autoRun: { provider: "claude" },
    providers: { claude: { command: ["wrapper", "claude"], interactive: { deniedTools: [], future: true } }, chatgpt: {} },
    futureRoot: true,
  }));

  assert.deepEqual(parsed.value.configurationFor("claude", "interactive"), {
    platform: "claude",
    settings: {
      shape: "default",
      declaredCommand: ["wrapper", "claude"],
      deniedTools: [],
    },
  });
  assert.equal(parsed.diagnostics.length, 1);
  assert.match(parsed.diagnostics[0]!.message, /futureRoot/u);
  assert.match(parsed.diagnostics[0]!.message, /providers\.claude\.interactive\.future/u);
});

test("invalid known launch fields block configuration", () => {
  for (const text of [
    "not json",
    "[]",
    '{"version":2,"platform":"claude"}',
    '{"version":1,"autoRun":{"provider":"codex"}}',
    providerFile("claude", { command: "claude" }),
    providerFile("claude", { command: [] }),
    providerFile("claude", { interactive: { model: "by-difficulty" } }),
    providerFile("claude", { explore: { deniedTools: ["Agent"] } }),
    providerFile("claude", { address: { effort: "inherit" } }),
    providerFile("claude", { review: { deniedTools: "Agent" } }),
    providerFile("claude", { address: { model: "gpt-5.6-sol" } }),
    providerFile("chatgpt", { interactive: { model: "sonnet" } }),
  ]) {
    assert.throws(() => parseLaunchFile(text), LaunchFileError, text);
  }
});

test("version 1 requires both provider blocks and rejects other versions", () => {
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"claude","command":["claude"]}'),
    (error: LaunchFileError) => /version must be 1/u.test(error.message)
      && /"autoRun"/u.test(error.message)
      && /"providers"/u.test(error.message),
  );
  for (const missing of ["claude", "chatgpt"] as const) {
    const providers = missing === "claude" ? { chatgpt: {} } : { claude: {} };
    assert.throws(
      () => parseLaunchFile(JSON.stringify({ version: 1, autoRun: { provider: "claude" }, providers })),
      new RegExp(`providers\\.${missing} is required`, "u"),
    );
  }
});

test("a provider's own parse failures name the provider that owns them", () => {
  for (const provider of ["claude", "chatgpt"] as const) {
    assert.throws(
      () => parseLaunchFile(providerFile(provider, { command: [] })),
      new RegExp(`providers\\.${provider}\\.command`, "u"),
    );
  }
});

test("shared session settings are validated without becoming provider configuration", () => {
  const text = JSON.stringify({ version: 1, autoRun: { provider: "claude" }, providers: { claude: {}, chatgpt: {} }, session: { stopWaitHours: 1.5 } });
  assert.equal(parseLaunchFile(text).diagnostics.length, 0);
  assert.throws(() => parseLaunchFile(JSON.stringify({ version: 1, autoRun: { provider: "claude" }, providers: { claude: {}, chatgpt: {} }, session: { stopWaitHours: -1 } })), /stopWaitHours/u);
  assert.match(parseLaunchFile(JSON.stringify({ version: 1, autoRun: { provider: "claude" }, providers: { claude: {}, chatgpt: {} }, stopWaitHours: 1.5 })).diagnostics[0]!.message, /stopWaitHours/u);
});

test("provider diagnostics identify unknown and cross-platform settings", () => {
  assert.throws(() => parseLaunchFile('{"version":1,"autoRun":{"provider":"codex"}}'), /autoRun\.provider must be.*claude.*chatgpt.*codex/u);
  assert.throws(
    () => parseLaunchFile(providerFile("claude", { address: { model: "gpt-5.6-sol" } })),
    /address\.model is not valid for platform claude/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { model: "sonnet" } })),
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

  await writeFile(path, providerFile("claude", { command: [] }), "utf8");
  await assert.rejects(source.get("interactive"), LaunchFileError);
});

test("launch configuration resolves project, then global, then built-in defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-resolution-"));
  const project = join(root, "project", ".harness", "launch.json");
  const global = join(root, "home", ".harness", "launch.json");
  await mkdir(join(root, "home", ".harness"), { recursive: true });
  const source = new FileLaunchConfigurationSource({ project, global });

  assert.equal((await source.load()).value.autoRunProvider, "claude");
  await writeFile(global, providerFile("chatgpt", { command: ["global-codex"] }), "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["global-codex"]);

  await mkdir(join(root, "project", ".harness"), { recursive: true });
  await writeFile(project, JSON.stringify({ version: 1, autoRun: { provider: "claude" }, providers: { claude: { command: ["project-claude"] }, chatgpt: { command: ["project-codex"] } } }), "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["project-claude"]);
  assert.deepEqual(settings(await source.getFor("chatgpt", "general")).declaredCommand, ["project-codex"]);
});
