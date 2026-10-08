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

const defaults = '{"version":1}';

test("loop limits and by-difficulty delegation profiles are accepted without changing interactive defaults", () => {
  const parsed = parseLaunchFile(JSON.stringify({
    version: 1, loop: { maxFeedback: 3, maxImplementers: 2, freshContextPercent: 65 },
    providers: {
      claude: { delegations: { loop: { model: "by-difficulty" } } },
      chatgpt: { delegations: { loop: { model: "by-difficulty" } } },
    },
  }));
  assert.deepEqual(parsed.diagnostics, []);
  for (const provider of ["claude", "chatgpt"] as const) {
    const loop = settings(parsed.value.delegationConfigurationFor(provider, "loop"));
    assert.equal(loop.declaredModel, "by-difficulty");
    assert.equal(loop.declaredEffort, "by-difficulty");
    assert.equal(settings(parsed.value.configurationFor(provider, "interactive")).declaredModel, undefined);
  }
  for (const loop of [{ maxFeedback: -1 }, { maxImplementers: 0 }, { freshContextPercent: 101 }]) {
    assert.throws(() => parseLaunchFile(JSON.stringify({ version: 1, loop })), LaunchFileError);
  }
});

test("loop launch resolves the worktree profile instead of the open window's profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-loop-config-"));
  const main = join(root, "main", ".harness", "config.json");
  const cwd = join(root, "feature");
  await mkdir(join(root, "main", ".harness"), { recursive: true });
  await mkdir(join(cwd, ".harness"), { recursive: true });
  await writeFile(main, providerFile("claude", { delegations: { loop: { model: "opus" } } }));
  await writeFile(join(cwd, ".harness", "config.json"), providerFile("claude", { delegations: { loop: { model: "haiku", effort: "low" } } }));
  const source = new FileLaunchConfigurationSource(main);
  const worktree = settings(await source.getDelegationForWorktree("claude", "loop", cwd));
  assert.equal(worktree.declaredModel, "haiku");
  assert.equal(worktree.declaredEffort, "low");
  assert.equal(settings(await source.getDelegationFor("claude", "loop")).declaredModel, "opus");
});

function settings(value: { readonly settings: unknown }): LaunchConfiguration {
  return value.settings as LaunchConfiguration;
}

function providerFile(provider: "claude" | "chatgpt", value: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, autoRun: { provider }, providers: { [provider]: value } });
}

test("a sparse config.json uses product-owned defaults", () => {
  const parsed = parseLaunchFile(defaults);

  assert.equal(parsed.value.autoRunProvider, "claude");
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "interactive")), {
    shape: "default", declaredCommand: ["claude"], deniedTools: [],
  });
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "explore")), {
    shape: "builtin", agentName: "Explore", declaredCommand: ["claude"], declaredModel: "haiku", declaredEffort: "low", deniedTools: [],
  });
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "explore")), {
    shape: "explore", declaredCommand: ["codex"], declaredModel: "gpt-5.6-luna", declaredEffort: "low",
  });
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "address")), {
    shape: "skill", skillName: "address-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty",
  });
});

test("config.json configures providers independently while Claude remains the Auto Run default", () => {
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

test("task commands override their provider command independently", () => {
  const parsed = parseLaunchFile(JSON.stringify({
    version: 1,
    providers: {
      claude: {
        command: ["claude"],
        delegations: { explore: { command: ["clauder", "run", "kiro"] } },
        autoRun: {
          explore: { command: ["clauder", "run", "kiro"] },
          address: { command: ["claude", "--address-profile"] },
        },
      },
      chatgpt: {
        command: ["codex"],
        delegations: { websearch: { command: ["codex-wrapper", "search"] } },
        autoRun: { review: { command: ["codex-wrapper", "review"] } },
      },
    },
  }));

  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("claude", "explore")).declaredCommand, ["clauder", "run", "kiro"]);
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "explore")).declaredCommand, ["clauder", "run", "kiro"]);
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "address")).declaredCommand, ["claude", "--address-profile"]);
  assert.deepEqual(settings(parsed.value.configurationFor("claude", "review")).declaredCommand, ["claude"]);
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("chatgpt", "websearch")).declaredCommand, ["codex-wrapper", "search"]);
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "review")).declaredCommand, ["codex-wrapper", "review"]);
  assert.deepEqual(settings(parsed.value.configurationFor("chatgpt", "address")).declaredCommand, ["codex"]);
  assert.deepEqual(parsed.diagnostics, []);
});

test("config.json resolves interactive and Auto Run profiles", () => {
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
  assert.deepEqual(parsed.value.configurationFor("claude", "explore"), {
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

test("manual delegation tasks have independently configurable profiles", () => {
  const parsed = parseLaunchFile(JSON.stringify({
    version: 1,
    providers: {
      claude: { delegations: { prototype: { model: "sonnet", effort: "high" }, review: { model: "opus", effort: "max" } } },
      chatgpt: { delegations: { websearch: { model: "gpt-5.6-sol", effort: "xhigh" } } },
    },
  }));

  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("claude", "prototype")), {
    shape: "default", declaredCommand: ["claude"], declaredModel: "sonnet", declaredEffort: "high", deniedTools: [],
  });
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("claude", "review")), {
    shape: "default", declaredCommand: ["claude"], declaredModel: "opus", declaredEffort: "max", deniedTools: [],
  });
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("chatgpt", "websearch")), {
    shape: "default", declaredCommand: ["codex"], declaredModel: "gpt-5.6-sol", declaredEffort: "xhigh",
  });
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("chatgpt", "brainstorm")), {
    shape: "default", declaredCommand: ["codex"],
  });
});

test("Claude keeps tool denials local to the profile that declares them", () => {
  const parsed = parseLaunchFile(providerFile("claude", {
    interactive: { deniedTools: ["Agent"] },
    delegations: { prototype: { deniedTools: ["WebSearch", "WebFetch"] } },
  }));

  assert.deepEqual(settings(parsed.value.configurationFor("claude", "interactive")).deniedTools, ["Agent"]);
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("claude", "prototype")).deniedTools, ["WebSearch", "WebFetch"]);
  assert.deepEqual(settings(parsed.value.delegationConfigurationFor("claude", "brainstorm")).deniedTools, []);
});

test("config.json selects an attended ChatGPT session with its Codex command", () => {
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

test("config.json selects a read-only ChatGPT explore session and still refuses unsupported kinds", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["codex"], autoRun: { explore: { model: "gpt-test", effort: "low" } } }));

  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.value.configurationFor("chatgpt", "explore"), {
    platform: "chatgpt",
    settings: {
      shape: "explore",
      declaredCommand: ["codex"],
      declaredModel: "gpt-test",
      declaredEffort: "low",
    },
  });
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { autoRun: { explore: { model: "opus" } } })),
    /autoRun\.explore\.model is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { autoRun: { explore: { effort: "max" } } })),
    /autoRun\.explore\.effort is not valid for platform chatgpt/u,
  );
});

test("config.json routes a ChatGPT address without overriding native tool settings", () => {
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

test("config.json routes ChatGPT review workers through the review skill their disposition selects", () => {
  const parsed = parseLaunchFile(providerFile("chatgpt", { command: ["codex"], autoRun: { review: { effort: "high" } } }));

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
  const parsed = parseLaunchFile(providerFile("chatgpt", { autoRun: { address: { model: "gpt-5.6-sol", effort: "xhigh", webSearch: "live", subagents: "allowed" } } }));

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
    () => parseLaunchFile(providerFile("chatgpt", { autoRun: { address: { model: "opus" } } })),
    /autoRun\.address\.model is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { autoRun: { address: { effort: "max" } } })),
    /autoRun\.address\.effort is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { autoRun: { address: { webSearch: "everything" } } })),
    /autoRun\.address\.webSearch is not valid for platform chatgpt/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { webSearch: "live" } })),
    /interactive\.webSearch is only supported for Auto Run address and review profiles/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { model: "by-difficulty" } })),
    /interactive\.model is not valid for platform chatgpt/u,
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
    providerFile("claude", { delegations: { explore: { command: [] } } }),
    providerFile("chatgpt", { autoRun: { address: { command: "codex" } } }),
    providerFile("claude", { interactive: { model: "by-difficulty" } }),
    providerFile("claude", { autoRun: { explore: { deniedTools: ["Agent"] } } }),
    providerFile("claude", { autoRun: { address: { effort: "inherit" } } }),
    providerFile("claude", { autoRun: { review: { deniedTools: "Agent" } } }),
    providerFile("claude", { autoRun: { address: { model: "gpt-5.6-sol" } } }),
    providerFile("chatgpt", { interactive: { model: "sonnet" } }),
  ]) {
    assert.throws(() => parseLaunchFile(text), LaunchFileError, text);
  }
});

test("config.json requires only its format marker", () => {
  assert.throws(
    () => parseLaunchFile('{"version":2,"platform":"claude","command":["claude"]}'),
    (error: LaunchFileError) => /version must be 1/u.test(error.message)
      && /\{"version": 1\}/u.test(error.message),
  );
  assert.doesNotThrow(() => parseLaunchFile('{"version":1}'));
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

test("the grill hook's shared section is not an unsupported field", () => {
  assert.equal(parseLaunchFile(JSON.stringify({ version: 1, grill: { url: "https://grill.test" } })).diagnostics.length, 0);
});

test("provider diagnostics identify unknown and cross-platform settings", () => {
  assert.throws(() => parseLaunchFile('{"version":1,"autoRun":{"provider":"codex"}}'), /autoRun\.provider must be.*claude.*chatgpt.*codex/u);
  assert.throws(
    () => parseLaunchFile(providerFile("claude", { autoRun: { address: { model: "gpt-5.6-sol" } } })),
    /autoRun\.address\.model is not valid for platform claude/u,
  );
  assert.throws(
    () => parseLaunchFile(providerFile("chatgpt", { interactive: { model: "sonnet" } })),
    /interactive\.model is not valid for platform chatgpt/u,
  );
});

test("the file source reads the latest valid config.json on every launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-file-"));
  const path = join(root, "config.json");
  const source = new FileLaunchConfigurationSource(path);
  await writeFile(path, defaults, "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["claude"]);

  await writeFile(path, providerFile("claude", { command: ["wrapper", "claude"] }), "utf8");
  assert.deepEqual(settings(await source.get("interactive")).declaredCommand, ["wrapper", "claude"]);

  await writeFile(path, providerFile("claude", { command: [] }), "utf8");
  await assert.rejects(source.get("interactive"), LaunchFileError);
});

test("launch configuration resolves project, then global, then built-in defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-launch-resolution-"));
  const project = join(root, "project", ".harness", "config.json");
  const global = join(root, "home", ".harness", "config.json");
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
