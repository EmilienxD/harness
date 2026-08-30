import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BY_DIFFICULTY,
  DEFAULT_MAX_INLINE_PROMPT_CHARS,
  DIFFICULTY_LAUNCH_POLICIES,
  EFFORT_LEVELS,
  MAX_COMMAND_LINE_CHARS,
  LaunchPlanError,
  describeLaunchPlan,
  isEffortLevel,
  launchWriteCapability,
  parseClaudeCommand,
  planLaunch,
  planManagerResume,
  planSessionResume,
  resolveLaunchConfiguration,
  type EffortLevel,
  type LaunchPlanRequest,
} from "../src/claude/launch.js";
import { resolvedPromptFromText } from "../src/claude/prompts.js";
import {
  FileSystemPromptSpillStore,
  PromptSpillPathError,
} from "../src/claude/spill.js";
import { ShellQuotingError, buildChangeDirectoryCommandLine, buildCommandLine, quoteArgument } from "../src/claude/shell.js";
import { deriveWriteCapability } from "../src/domain/capability.js";
import { managerMcpConfigDocument } from "../src/bridge/mcp-config.js";
import type { AgentId, SessionId } from "../src/domain/contracts.js";
import type { IssueDifficulty } from "../src/shared/labels.js";

const agentId = "a1b2c3" as AgentId;
const sessionId = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" as SessionId;

const IMPLEMENTER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"];
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh *)", "Bash(git diff*)", "LSP"];
const BRAINSTORMER_TOOLS = ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Write", "Edit", "Skill"];
const MANAGER_TOOLS = ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Skill"];
/** The pre-approved delegation surface the Manager's command line carries, derived from its definition's `mcp__aboard__*` rule. */
const ABOARD_ALLOW_ARGS = [
  "--allowedTools",
  "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr",
];
const BRAINSTORMER_ALLOW_ARGS = [
  "--allowedTools",
  "mcp__aboard__run_agent,mcp__aboard__continue_agent",
] as const;

function definition(
  agentName: string,
  declaredTools: readonly string[],
  extra: Omit<Parameters<typeof resolveLaunchConfiguration>[0], "agentName" | "systemPrompt" | "declaredTools"> = {},
) {
  return resolveLaunchConfiguration({
    agentName,
    systemPrompt: `You are the ${agentName}.`,
    declaredTools,
    ...extra,
  });
}

const runtimeDir = `.aboard/runtime/agents/${agentId}`;
const runtimeName = (agentName: string) => `aboard-${agentName}-${agentId}`;
const runtimePath = (agentName: string) => `${runtimeDir}/.claude/agents/${runtimeName(agentName)}.md`;
const runtimeArgs = ["--add-dir", runtimeDir, "--settings", `${runtimeDir}/settings.json`] as const;

/** The two flags every agent-defined launch and resume carries, in order. */
function definitionArgs(agentName: string): readonly string[] {
  return [...runtimeArgs, "--agent", runtimeName(agentName)];
}

const definitionFlags = (agentName: string) => `--add-dir ${runtimeDir} --settings ${runtimeDir}/settings.json --agent ${runtimeName(agentName)}`;

function request(overrides: Partial<LaunchPlanRequest> = {}): LaunchPlanRequest {
  return {
    agentId,
    sessionId,
    agentType: "implementer",
    shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS),
    prompt: "Address issue #47.",
    ...overrides,
  };
}

test("plans the Manager from its definition rather than a discoverable agent", () => {
  const plan = planLaunch(
    request({
      agentType: "manager",
      configuration: definition("manager", MANAGER_TOOLS),
      disallowedTools: ["Bash(git push*)"],
      prompt: undefined,
      model: "opus",
    }),
  );

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("manager"),
    "--allowedTools",
    "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr",
    "--disallowedTools",
    "Bash(git push*)",
    "--model",
    "opus",
  ]);
  assert.equal(
    plan.commandLine,
    `& claude --session-id ${sessionId} ${definitionFlags("manager")} --allowedTools 'mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr' --disallowedTools 'Bash(git push*)' --model opus`,
  );
  assert.equal(plan.agentDefinition?.relativePath, runtimePath("manager"));
  assert.equal(
    plan.agentDefinition?.contents,
    `---\nname: ${runtimeName("manager")}\ndescription: aboard manager agent\ntools: ${MANAGER_TOOLS.join(", ")}\n---\n\nYou are the manager.\n`,
  );
  assert.equal(plan.promptDelivery, "none");
  // The Manager orchestrates and is never a lease holder, even though its
  // The tool list leaves unrestricted Bash in place by design.
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, false);
});

test("the aboard MCP server is registered only for catalog-owning defined roles", () => {
  const mcpConfigPath = "C:\\storage\\aboard\\manager-mcp.json";
  const configuration = definition("manager", MANAGER_TOOLS);
  const plan = planLaunch(request({ agentType: "manager", configuration, prompt: undefined, mcpConfigPath }));

  assert.deepEqual(plan.args, [
    "--session-id", sessionId, "--mcp-config", mcpConfigPath, ...definitionArgs("manager"),
    "--allowedTools",
    "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr",
  ]);
  // `--mcp-config` is variadic, so like `--add-dir` it must never end the line:
  // the positional prompt would be read as a second config path.
  assert.equal(plan.args[plan.args.indexOf("--mcp-config") + 2], "--add-dir");
  // `--strict-mcp-config` would drop every server the *user* configured.
  assert.equal(plan.args.includes("--strict-mcp-config"), false);
  // Nothing about the registration reaches the definition file.
  assert.equal(plan.agentDefinition?.contents.includes("mcpServers"), false);

  // A resume re-passes it like every other launch flag: the Manager's allowlist
  // still admits `mcp__aboard__*`, and without the server it has nothing to call.
  const resumed = planManagerResume({ agentId, sessionId, configuration, shell: "powershell", mcpConfigPath });
  assert.deepEqual(resumed.args, [
    "--resume", sessionId, "--mcp-config", mcpConfigPath, ...definitionArgs("manager"),
    "--allowedTools",
    "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr",
  ]);

  const brainstormer = definition("brainstormer", BRAINSTORMER_TOOLS);
  const brainstormPath = "C:\\storage\\aboard\\agent-mcp\\brain-1.json";
  const brainstormLaunch = planLaunch(request({
    agentType: "brainstormer",
    configuration: brainstormer,
    prompt: "Settle the cache design",
    attended: true,
    mcpConfigPath: brainstormPath,
  }));
  assert.equal(brainstormLaunch.args.includes(brainstormPath), true);
  assert.equal(brainstormLaunch.args[brainstormLaunch.args.indexOf("--allowedTools") + 1], BRAINSTORMER_ALLOW_ARGS[1]);
  const brainstormResume = planSessionResume({
    agentId,
    sessionId,
    agentType: "brainstormer",
    shell: "powershell",
    configuration: brainstormer,
    attended: true,
    mcpConfigPath: brainstormPath,
    prompt: "Check one follow-up",
  });
  assert.equal(brainstormResume.args.includes(brainstormPath), true);
  assert.equal(brainstormResume.args[brainstormResume.args.indexOf("--allowedTools") + 1], BRAINSTORMER_ALLOW_ARGS[1]);
  assert.match(brainstormResume.commandLine, /Check one follow-up/u);

  // A worker's launch carries no registration at all: the delegation surface is
  // not merely denied to it, it is absent from its context.
  assert.equal(planLaunch(request()).args.includes("--mcp-config"), false);
  // And it is refused outright for a shape that has no definition to bound it —
  // a `--mcp-config` with no flag behind it would swallow the prompt.
  assert.throws(
    () => planLaunch(request({ configuration: resolveLaunchConfiguration({}), mcpConfigPath })),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("the Manager's command line pre-approves the aboard MCP tools and nothing else", () => {
  const allowed = "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr";
  const configuration = definition("manager", MANAGER_TOOLS);

  const plan = planLaunch(request({ agentType: "manager", configuration, prompt: undefined }));
  assert.equal(plan.args[plan.args.indexOf("--allowedTools") + 1], allowed);
  // A resume re-passes it exactly.
  const resumed = planManagerResume({ agentId, sessionId, configuration, shell: "powershell" });
  assert.equal(resumed.args[resumed.args.indexOf("--allowedTools") + 1], allowed);

  // Every aboard tool is enumerated: a wildcard would silently pre-approve a
  // tool the boundary later adds without a matching permission rule.
  assert.equal(allowed.includes("*"), false);

  assert.equal(planLaunch(request()).args.includes("--allowedTools"), false);
  assert.equal(planLaunch(request({ agentType: "Explore", configuration: { shape: "builtin", agentName: "Explore" } })).args.includes("--allowedTools"), false);
  assert.equal(planLaunch(request({ agentType: "general-purpose", configuration: resolveLaunchConfiguration({}) })).args.includes("--allowedTools"), false);

  const withoutServer = definition("manager", ["Read", "Grep", "Glob", "Bash", "Skill"]);
  assert.equal(planLaunch(request({ agentType: "manager", configuration: withoutServer, prompt: undefined })).args.includes("--allowedTools"), false);
});

test("the Manager MCP registration resolves the live port and token", () => {
  const document = JSON.parse(
    managerMcpConfigDocument({ port: 51234, token: "t0ken", agentId: "m1" }),
  ) as { mcpServers: Record<string, { url: string; alwaysLoad: boolean; headers: Record<string, string> }> };

  assert.deepEqual(document.mcpServers.aboard, {
    type: "http",
    url: "http://127.0.0.1:51234/mcp",
    alwaysLoad: true,
    headers: { Authorization: "Bearer t0ken", "X-Aboard-Agent-Id": "m1" },
  });
});

test("wrapper layout keeps child argv out of the visible launch and resume lines", () => {
  const wrapper = {
    script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py",
    lockPathFor: (id: typeof agentId) => `C:\\repo\\.aboard\\runtime\\locks\\${id}.lock`,
  };
  const plan = planLaunch(request({ wrapper }));
  // plan.args keeps the claude-side view; only the command line changes.
  assert.equal(plan.args[2], "--add-dir");
  assert.match(plan.commandLine, /^& uv run --no-project --no-managed-python 'C:\\repo\\\.aboard\\scripts\\aboard_wrapper\.py' /);
  assert.ok(plan.commandLine.includes(`'C:\\repo\\.aboard\\runtime\\locks\\${agentId}.lock' --request .aboard/runtime/agents/${agentId}/launch.json`));
  assert.doesNotMatch(plan.commandLine, /--allowedTools|--session-id/);
  assert.deepEqual(JSON.parse(plan.wrapperRequest!.contents), { command: ["claude", ...plan.args] });

  const resumed = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS), wrapper,
  });
  assert.match(resumed.commandLine, /aboard_wrapper\.py' .* --request \.aboard\/runtime\/agents\/a1b2c3\/launch\.json/);
  assert.deepEqual(JSON.parse(resumed.wrapperRequest!.contents), { command: ["claude", ...resumed.args] });
});

test("wrapper tokens are validated like the launch command", () => {
  const wrapper = {
    script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py",
    lockPathFor: () => 'has "quote".lock',
  };
  assert.throws(() => planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS), wrapper,
  }), /Wrapper token/);
});

test("plans an agent-defined implementer and spills a multi-line prompt", () => {
  const prompt = resolvedPromptFromText(
    "Address issue #47 — Add token refresh.\n\n## Issue #47\n\nRotate the token.",
  );
  const plan = planLaunch(request({ shell: "git-bash", prompt }));

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer"),
    "--disable-slash-commands",
    "Address issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.",
  ]);
  assert.equal(
    plan.commandLine,
    `claude --session-id ${sessionId} ${definitionFlags("implementer")} --disable-slash-commands 'Address issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.'`,
  );
  assert.equal(plan.promptDelivery, "spilled");
  assert.equal(plan.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3.md");
  assert.equal(plan.spill?.contents, `${prompt.text}\n`);
  assert.equal(plan.requiresWriteLease, true);
});

test("plans a read-only agent that stays concurrent", () => {
  const plan = planLaunch(
    request({
      agentType: "webresearcher",
      configuration: definition("webresearcher", READ_ONLY_TOOLS),
      prompt: "Research current API pricing.",
    }),
  );

  // This pure planner receives no infrastructure denial in this unit test; the
  // delegation coordinator supplies the aboard MCP denial to worker launches.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("webresearcher"),
    "--disable-slash-commands",
    "Research current API pricing.",
  ]);
  assert.equal(plan.writeCapability, "read-only");
  assert.equal(plan.requiresWriteLease, false);
});

test("plans general-purpose as Claude Code's unmodified default session", () => {
  const plan = planLaunch(
    request({
      agentType: "general-purpose",
      configuration: resolveLaunchConfiguration({}),
      prompt: undefined,
      attended: true,
    }),
  );

  assert.deepEqual(plan.args, ["--session-id", sessionId, ...runtimeArgs]);
  assert.equal(plan.commandLine, `& claude --session-id ${sessionId} --add-dir ${runtimeDir} --settings ${runtimeDir}/settings.json`);
  assert.equal(plan.agentDefinition, undefined);
  assert.equal(plan.promptDelivery, "none");
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, true);
});

test("Chrome is available only to implementers and is replayed on resume", () => {
  const generalPurpose = {
    agentId,
    sessionId,
    agentType: "general-purpose" as const,
    shell: "powershell" as const,
    configuration: resolveLaunchConfiguration({}),
    attended: true,
  };
  const implementer = planLaunch(request({ chrome: true }));
  assert.equal(implementer.args.includes("--chrome"), true);
  assert.equal(implementer.args.indexOf("--chrome") < implementer.args.indexOf("--disable-slash-commands"), true);
  assert.equal(planLaunch(request()).args.includes("--no-chrome"), false);
  const { prompt: _prompt, ...resumeRequest } = request({ chrome: true });
  assert.equal(planSessionResume(resumeRequest).args.includes("--chrome"), true);

  assert.throws(
    () => planLaunch({ ...generalPurpose, chrome: true }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("the builtin types carry Claude Code's own capabilities and Explore accepts policy-only overrides", () => {
  const builtin = (name: string) => resolveLaunchConfiguration({ agentName: name });
  assert.equal(builtin("Explore").shape, "builtin");
  assert.equal(launchWriteCapability("Explore", builtin("Explore")), "read-only");
  assert.equal(launchWriteCapability("general-purpose", resolveLaunchConfiguration({})), "write-capable");

  const explore = planLaunch(request({
    agentType: "Explore",
    configuration: builtin("Explore"),
    prompt: "Map the auth flow.",
  }));
  assert.equal(explore.requiresWriteLease, false);
  // The bare profile resolves to --agent <builtin name> with no tool flags.
  assert.deepEqual(explore.args, ["--session-id", sessionId, ...runtimeArgs, "--agent", "Explore", "--disable-slash-commands", "Map the auth flow."]);

  const profiled = resolveLaunchConfiguration({
    agentName: "Explore",
    declaredModel: "haiku",
    declaredEffort: "high",
    declaredCommand: ["wrapper", "run", "MyProfile", "--"],
  });
  const configured = planLaunch(request({
    agentType: "Explore",
    configuration: profiled,
    prompt: "Map the auth flow.",
  }));
  assert.deepEqual(configured.command, ["wrapper", "run", "MyProfile", "--"]);
  assert.deepEqual(configured.args, [
    "--session-id", sessionId, ...runtimeArgs, "--agent", "Explore", "--model", "haiku", "--effort", "high", "--disable-slash-commands", "Map the auth flow.",
  ]);
  assert.equal(configured.args.includes("--tools"), false);
  assert.equal(configured.agentDefinition, undefined);
});

test("passes the session effort level on every launch shape and refuses an unknown one", () => {
  const plan = planLaunch(request({ effort: "xhigh" }));
  // --effort sits with the other session flags, before the positional prompt.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer"),
    "--effort",
    "xhigh",
    "--disable-slash-commands",
    "Address issue #47.",
  ]);

  // A resume re-passes the definition's own flags too — see the resume test
  // below for why — so the session level only fills the gap it leaves.
  assert.deepEqual(
    planManagerResume({
      agentId, sessionId, shell: "powershell", effort: "low",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args,
    ["--resume", sessionId, ...definitionArgs("manager"), ...ABOARD_ALLOW_ARGS, "--effort", "low"],
  );
  assert.deepEqual(
    planSessionResume({
      agentId,
      sessionId,
      agentType: "implementer",
      shell: "powershell",
      configuration: definition("implementer", IMPLEMENTER_TOOLS),
      effort: "max",
    }).args,
    ["--resume", sessionId, ...definitionArgs("implementer"), "--effort", "max", "--disable-slash-commands"],
  );

  // Unset is the documented "inherit": no flag at all, so Claude Code's own
  // effortLevel setting keeps deciding.

  assert.equal(planLaunch(request()).args.includes("--effort"), false);
  assert.equal(
    planManagerResume({
      agentId, sessionId, shell: "powershell",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args.includes("--effort"),
    false,
  );

  for (const level of EFFORT_LEVELS) {
    assert.equal(isEffortLevel(level), true);
    assert.deepEqual(planLaunch(request({ effort: level })).args.slice(8, 10), ["--effort", level]);
  }
  for (const invalid of ["ultracode", "highest", "", "--max"]) {
    assert.equal(isEffortLevel(invalid), false);
    assert.throws(
      () => planLaunch(request({ effort: invalid as EffortLevel })),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-effort",
      `${invalid} must be refused as an effort level`,
    );
  }
});

test("puts the definition's model and effort on the command line, overriding the session settings", () => {
  const configuration = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredModel: "opus",
    declaredEffort: "high",
  });
  const plan = planLaunch(
    request({ configuration, model: "haiku", effort: "low" }),
  );
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer"),
    "--model",
    "opus",
    "--effort",
    "high",
    "--disable-slash-commands",
    "Address issue #47.",
  ]);

  // Each field falls back independently: a definition that declares only one
  // leaves the setting deciding the other.
  assert.deepEqual(
    planLaunch(request({
      configuration: definition("brainstormer", BRAINSTORMER_TOOLS, { declaredModel: "opus" }),
      agentType: "brainstormer",
      effort: "low",
    })).args.slice(8),
    ["--allowedTools", "mcp__aboard__run_agent,mcp__aboard__continue_agent", "--model", "opus", "--effort", "low", "Address issue #47."],
  );

  // `model: inherit` is the definition declining to choose, which is no flag —
  // not a model literally named "inherit", which would fail the launch.
  const inherited = definition("implementer", IMPLEMENTER_TOOLS, { declaredModel: "inherit" });
  assert.equal("declaredModel" in inherited, false);
  assert.equal(
    planLaunch(request({ configuration: inherited })).args.includes("--model"),
    false,
  );

  // On a resume the definition still wins over the session settings, because
  // the resume re-reads it and re-passes every flag the launch did.
  assert.deepEqual(
    planSessionResume({
      agentId,
      sessionId,
      agentType: "implementer",
      shell: "powershell",
      configuration,
      model: "haiku",
      effort: "low",
    }).args,
    ["--resume", sessionId, ...definitionArgs("implementer"), "--model", "opus", "--effort", "high", "--disable-slash-commands"],
  );
  assert.deepEqual(
    planManagerResume({
      agentId, sessionId, shell: "powershell", model: "opus",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args,
    ["--resume", sessionId, ...definitionArgs("manager"), ...ABOARD_ALLOW_ARGS, "--model", "opus"],
  );

  for (const invalid of ["", "  ", "--sonnet"]) {
    assert.throws(
      () => definition("implementer", IMPLEMENTER_TOOLS, { declaredModel: invalid }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-model",
      `${invalid} must be refused as a definition model`,
    );
  }
  assert.throws(
    () => definition("implementer", IMPLEMENTER_TOOLS, { declaredEffort: "ultra" as EffortLevel }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-effort",
  );
  // The declared fields describe a definition and are meaningless without one.
  for (const input of [{ declaredModel: "opus" }, { declaredEffort: "high" as EffortLevel }]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
    );
  }
});

test("by-difficulty hands model and effort to the issue's tier, and a declared value takes them back", () => {
  const routed = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredModel: BY_DIFFICULTY,
    declaredEffort: BY_DIFFICULTY,
  });
  // The tiers are data. What is asserted here is that each one reaches the
  // command line whole, not what any particular tier happens to be worth.
  for (const [difficulty, policy] of Object.entries(DIFFICULTY_LAUNCH_POLICIES)) {
    assert.deepEqual(
      planLaunch(request({ configuration: routed, difficulty: difficulty as IssueDifficulty })).args.slice(8),
      ["--model", policy.model, "--effort", policy.effort, "--disable-slash-commands", "Address issue #47."],
      `the ${difficulty} tier must reach the command line`,
    );
  }

  assert.deepEqual(
    planLaunch(request({ configuration: routed })).args.slice(8),
    ["--model", "opus", "--effort", "high", "--disable-slash-commands", "Address issue #47."],
  );
  // ...and the session-wide setting does not get to fill the gap either, since
  // the definition did choose — it chose to ask the label.
  assert.deepEqual(
    planLaunch(request({ configuration: routed, model: "haiku", effort: "low" })).args.slice(8, 12),
    ["--model", "opus", "--effort", "high"],
  );

  // A definition that names either field keeps it. The two resolve
  // independently, so one agent may route its model and pin its effort.
  const pinned = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredModel: "opus",
    declaredEffort: BY_DIFFICULTY,
  });
  assert.deepEqual(
    planLaunch(request({ configuration: pinned, difficulty: "routine" })).args.slice(8, 12),
    ["--model", "opus", "--effort", "medium"],
  );
  assert.deepEqual(
    planLaunch(request({
      configuration: definition("implementer", IMPLEMENTER_TOOLS, { declaredModel: BY_DIFFICULTY, declaredEffort: "max" }),
      difficulty: "routine",
    })).args.slice(8, 12),
    ["--model", "haiku", "--effort", "max"],
  );

  // A difficulty carried by a launch whose definition never asked for one
  // changes nothing at all.
  assert.deepEqual(
    planLaunch(request({ difficulty: "routine" })).args.includes("--model"),
    false,
  );

  const file = planLaunch(request({ configuration: routed, difficulty: "basic" })).agentDefinition;
  assert.match(file?.contents ?? "", /^model: sonnet$/mu);
  assert.match(file?.contents ?? "", /^effort: high$/mu);
  assert.doesNotMatch(file?.contents ?? "", new RegExp(BY_DIFFICULTY, "u"));

  // Resume is the same launch policy or it is a different agent: a reopened
  // session must not come back cheaper than it started.
  assert.deepEqual(
    planSessionResume({
      agentId,
      sessionId,
      agentType: "implementer",
      shell: "powershell",
      configuration: routed,
      difficulty: "routine",
    }).args,
    ["--resume", sessionId, ...definitionArgs("implementer"), "--model", "haiku", "--effort", "medium", "--disable-slash-commands"],
  );

  // The sentinel is a launch-policy value like any other, so a builtin profile
  // may carry it too.
  assert.deepEqual(
    planLaunch(request({
      configuration: resolveLaunchConfiguration({ agentName: "Explore", declaredModel: BY_DIFFICULTY }),
      agentType: "Explore",
      difficulty: "advanced",
    })).args.slice(8, 10),
    ["--model", "opus"],
  );
});

test("rejects every tool override beside a builtin --agent but accepts launch policy", () => {
  for (const input of [
    { agentName: "Explore", tools: ["Read"] },
    { agentName: "general-purpose", tools: ["Read", "Grep"] },
  ]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "conflicting-launch-shape",
    );
  }

  // A builtin profile is metadata-only: its parser produces no declaredTools,
  // and the launch boundary refuses one even if a caller tries to bypass it.
  for (const input of [
    { agentName: "Explore", declaredTools: ["Read"] },
  ]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "conflicting-launch-shape",
    );
  }

  assert.deepEqual(resolveLaunchConfiguration({
    agentName: "Explore", declaredModel: "opus", declaredEffort: "high", declaredCommand: ["wrapper"],
  }), {
    shape: "builtin", agentName: "Explore", declaredModel: "opus", declaredEffort: "high", declaredCommand: ["wrapper"],
  });

  assert.throws(
    () => resolveLaunchConfiguration({ declaredTools: ["Read"] }),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
  );
});

test("refuses a definition that cannot produce a complete command line", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    assert.throws(
      () => resolveLaunchConfiguration({ agentName: "implementer", systemPrompt: empty, declaredTools: ["Read"] }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "missing-system-prompt",
      `${JSON.stringify(empty)} must be refused as a system prompt`,
    );
  }

  // An absent `--tools` flag leaves Claude Code's default tool behavior intact;
  // an empty allowlist is a refused launch, not a permissive one.
  assert.throws(
    () => resolveLaunchConfiguration({ agentName: "implementer", systemPrompt: "You are it.", declaredTools: [] }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "missing-declared-tools",
  );

  // The name becomes a file name under the runtime directory. A plugin-scoped
  // name is a legal `--agent` value but can never name an aboard definition.
  assert.throws(
    () => resolveLaunchConfiguration({ agentName: "plugin:implementer", systemPrompt: "You are it.", declaredTools: ["Read"] }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-agent-name",
  );
});

test("an agent-defined launch registers its definition where only that launch can find it", () => {
  const configuration = definition("implementer", ["Read", "Agent(Explore)"], {
    declaredDescription: "Implement one issue.",
    declaredModel: "opus",
    declaredEffort: "high",
    extraFrontmatter: ["color: green", "maxTurns: 40", "hooks:", "  PreToolUse: []"],
  });
  const plan = planLaunch(request({ configuration, prompt: "Go." }));

  assert.deepEqual(plan.args, [
    "--session-id", sessionId, ...definitionArgs("implementer"),
    "--model", "opus", "--effort", "high", "--disable-slash-commands", "Go.",
  ]);
  assert.equal(plan.args.includes("--tools"), false);
  assert.equal(plan.args.includes("--system-prompt-file"), false);
  // `--add-dir` takes a list, so it must never end the line: the positional
  // prompt would be read as a second directory. `--agent` follows it directly.
  assert.equal(plan.args.at(-1), "Go.");
  assert.equal(plan.args[plan.args.indexOf("--add-dir") + 2], "--settings");

  assert.equal(plan.agentDefinition?.relativePath, runtimePath("implementer"));
  assert.equal(
    plan.agentDefinition?.contents,
    [
      "---",
      `name: ${runtimeName("implementer")}`,
      "description: Implement one issue.",
      "tools: Read, Agent(Explore)",
      "model: opus",
      "effort: high",
      // Keys aboard does not resolve are the author's and travel untouched —
      // `color:` among them, exactly where the definition declared it.
      "color: green",
      "maxTurns: 40",
      "hooks:",
      "  PreToolUse: []",
      "---",
      "",
      "You are the implementer.",
      "",
    ].join("\n"),
  );

  const resumed = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration,
  });
  assert.deepEqual(resumed.args, [
    "--resume", sessionId, ...definitionArgs("implementer"),
    "--model", "opus", "--effort", "high", "--disable-slash-commands",
  ]);
  assert.equal(resumed.agentDefinition?.relativePath, plan.agentDefinition?.relativePath);
  assert.equal(resumed.agentDefinition?.contents, plan.agentDefinition?.contents);

  // The directory and the name both carry the agent id, so one launch's
  // definition is never inside another's `--add-dir`.
  const other = planLaunch(request({ agentId: "z9" as AgentId, configuration, prompt: "Go." }));
  assert.equal(other.agentDefinition?.relativePath, ".aboard/runtime/agents/z9/.claude/agents/aboard-implementer-z9.md");
});

test("model and effort ride the command line as well as the rewritten file, on start and resume", () => {
  const configuration = definition("implementer", ["Read"], {
    declaredDescription: "d", declaredModel: "opus", declaredEffort: "high",
  });
  const flags = ["--model", "opus", "--effort", "high"];
  const plan = planLaunch(request({ configuration, prompt: "Go." }));
  assert.deepEqual(plan.args.slice(-6, -2), flags);
  assert.equal(plan.agentDefinition?.contents.includes("model: opus\neffort: high\n"), true);

  const resumed = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration,
  });
  assert.deepEqual(resumed.args.slice(-5, -1), flags);
  assert.deepEqual(
    planManagerResume({
      agentId, sessionId, shell: "powershell",
      configuration: definition("manager", MANAGER_TOOLS, { declaredModel: "opus", declaredEffort: "medium" }),
    }).args.slice(-4),
    ["--model", "opus", "--effort", "medium"],
  );

  const explore = resolveLaunchConfiguration({ agentName: "Explore", declaredModel: "haiku", declaredEffort: "low" });
  const exploreLaunch = planLaunch(request({
    agentType: "Explore", configuration: explore, prompt: "Map the auth flow.",
  }));
  assert.deepEqual(exploreLaunch.args, [
    "--session-id", sessionId, ...runtimeArgs, "--agent", "Explore", "--model", "haiku", "--effort", "low",
    "--disable-slash-commands", "Map the auth flow.",
  ]);
  assert.equal(exploreLaunch.agentDefinition, undefined);
  assert.equal(exploreLaunch.args.includes("--add-dir"), true);
  assert.deepEqual(
    planSessionResume({
      agentId, sessionId, agentType: "Explore", shell: "powershell", configuration: explore,
    }).args,
    ["--resume", sessionId, ...runtimeArgs, "--model", "haiku", "--effort", "low", "--disable-slash-commands"],
  );
});

test("passes carried-through frontmatter through and refuses a line that would close the fence", () => {
  for (const color of ["color: chartreuse", "color: #00ff00"]) {
    const configuration = definition("implementer", ["Read"], { extraFrontmatter: [color] });
    const plan = planLaunch(request({ configuration, prompt: "Go." }));
    assert.equal(plan.agentDefinition?.contents.includes(`${color}\n`), true, color);
  }
  // A carried-through line that closes the `---` fence would move the rest of
  // the frontmatter into the system prompt without any error.
  for (const line of ["---", "  ...  ", "maxTurns: 40\nname: hijacked"]) {
    assert.throws(
      () => definition("implementer", ["Read"], { extraFrontmatter: [line] }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-frontmatter",
      JSON.stringify(line),
    );
  }
  // A builtin has no file to write any of it into.
  for (const extra of [{ declaredDescription: "d" }, { extraFrontmatter: ["maxTurns: 40"] }]) {
    assert.throws(
      () => resolveLaunchConfiguration({ agentName: "Explore", ...extra }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "conflicting-launch-shape",
      JSON.stringify(extra),
    );
  }
});

test("pins each launch shape to the agent types allowed to use it", () => {
  const rejects = (overrides: Partial<LaunchPlanRequest>): void => {
    assert.throws(
      () => planLaunch(request({ prompt: "Do the thing.", ...overrides })),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "shape-not-allowed",
    );
  };

  // The Manager launches from its own definition and nothing else: no bare
  // inline launch (it would lose the persona), and no other agent name.
  rejects({ agentType: "manager", configuration: resolveLaunchConfiguration({ agentName: "Explore" }) });
  rejects({ agentType: "manager", configuration: definition("implementer", IMPLEMENTER_TOOLS) });

  // Every other type has a definition — aboard's or Claude Code's — and a bare
  // inline launch would leave it without persona and tool list alike.
  for (const agentType of ["webresearcher", "implementer", "pr-doctor-afk", "pr-doctor-hitl", "brainstormer"] as const) {
    rejects({ agentType, configuration: resolveLaunchConfiguration({ agentName: "Explore" }) });
  }

  rejects({ agentType: "Explore", configuration: definition("Explore", ["Read"]) });
  rejects({ agentType: "implementer", configuration: resolveLaunchConfiguration({ agentName: "implementer" }) });
  rejects({ agentType: "general-purpose", configuration: resolveLaunchConfiguration({ agentName: "general-purpose" }) });

  // The allowed pairings retain their distinct launch shapes.
  const generalPurpose = planLaunch(request({
    agentType: "general-purpose",
    configuration: resolveLaunchConfiguration({}),
  }));
  assert.deepEqual(generalPurpose.args.slice(6), ["--disable-slash-commands", "Address issue #47."]);
  assert.equal(generalPurpose.agentDefinition, undefined);
  const manager = planLaunch(request({
    agentType: "manager",
    configuration: definition("manager", MANAGER_TOOLS),
    prompt: undefined,
  }));
  assert.deepEqual(manager.args, [
    "--session-id", sessionId, ...definitionArgs("manager"),
    "--allowedTools",
    "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr",
  ]);
});

test("a resume re-passes every flag that shaped the launch", () => {
  const configuration = definition("webresearcher", READ_ONLY_TOOLS);
  const resumed = planSessionResume({
    agentId,
    sessionId,
    agentType: "webresearcher",
    shell: "powershell",
    configuration,
  });
  assert.deepEqual(resumed.args, [
    "--resume",
    sessionId,
    ...definitionArgs("webresearcher"),
    "--disable-slash-commands",
  ]);
  // The definition is rewritten on every resume, since nothing guarantees the
  // runtime directory survived between sessions.
  assert.equal(resumed.agentDefinition?.relativePath, runtimePath("webresearcher"));
  assert.equal(resumed.writeCapability, "read-only");
  assert.equal(resumed.requiresWriteLease, false);

  // A builtin's `--agent` selection is restored with its conversation.
  assert.deepEqual(
    planSessionResume({
      agentId, sessionId, agentType: "Explore", shell: "powershell",
      configuration: resolveLaunchConfiguration({ agentName: "Explore" }),
    }).args,
    ["--resume", sessionId, ...runtimeArgs, "--disable-slash-commands"],
  );
  const resumedExplore = planSessionResume({
    agentId, sessionId, agentType: "Explore", shell: "powershell",
    configuration: resolveLaunchConfiguration({
      agentName: "Explore", declaredModel: "haiku", declaredEffort: "high", declaredCommand: ["wrapper", "run", "MyProfile", "--"],
    }),
  });
  assert.deepEqual(resumedExplore.command, ["wrapper", "run", "MyProfile", "--"]);
  assert.deepEqual(resumedExplore.args, ["--resume", sessionId, ...runtimeArgs, "--model", "haiku", "--effort", "high", "--disable-slash-commands"]);
  assert.equal(resumedExplore.args.includes("--tools"), false);
  assert.equal(resumedExplore.agentDefinition, undefined);
  // The Manager resumes from its own definition or not at all.
  assert.throws(
    () => planManagerResume({
      agentId, sessionId, shell: "powershell",
      configuration: definition("implementer", IMPLEMENTER_TOOLS),
    }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("automated workers require a prompt and interactive workers do not", () => {
  for (const agentType of ["webresearcher", "implementer", "pr-doctor-afk"] as const) {
    assert.throws(
      () =>
        planLaunch(
          request({
            agentType,
            configuration: definition(agentType, IMPLEMENTER_TOOLS),
            prompt: "   ",
          }),
        ),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "missing-prompt",
      `${agentType} must refuse to launch without a prompt`,
    );
  }

  const brainstormer = planLaunch(
    request({
      agentType: "brainstormer",
      configuration: definition("brainstormer", BRAINSTORMER_TOOLS),
      prompt: undefined,
    }),
  );
  assert.equal(brainstormer.promptDelivery, "none");
  assert.equal(brainstormer.requiresWriteLease, true);
});

test("honours the inline prompt threshold at its boundary", () => {
  const inline = "x".repeat(DEFAULT_MAX_INLINE_PROMPT_CHARS);
  const spilled = "x".repeat(DEFAULT_MAX_INLINE_PROMPT_CHARS + 1);

  assert.equal(planLaunch(request({ prompt: inline })).promptDelivery, "inline");
  assert.equal(planLaunch(request({ prompt: spilled })).promptDelivery, "spilled");
  assert.equal(
    planLaunch(request({ prompt: spilled, maxInlinePromptChars: 10 })).promptDelivery,
    "spilled",
  );
  assert.equal(
    planLaunch(request({ prompt: inline, maxInlinePromptChars: 100_000 })).promptDelivery,
    "inline",
  );
});

test("spills what a shell cannot represent, per shell", () => {
  const quoted = 'Fix the "auth" bug.';
  assert.equal(planLaunch(request({ prompt: quoted, shell: "powershell" })).promptDelivery, "spilled");
  assert.equal(planLaunch(request({ prompt: quoted, shell: "git-bash" })).promptDelivery, "inline");
  assert.equal(planLaunch(request({ prompt: quoted, shell: "cmd" })).promptDelivery, "spilled");

  // A headline that is itself unquotable falls back to a generic stub.
  const plan = planLaunch(
    request({
      prompt: resolvedPromptFromText(`Fix the "auth" bug.\n${"detail ".repeat(1000)}`),
      shell: "powershell",
    }),
  );
  assert.deepEqual(plan.args.at(-1), "Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.");
});

test("quotes Windows paths with spaces, unicode, and quotes", () => {
  const path = "C:\\Program Files\\Claude Ünicode\\claude.exe";
  assert.equal(quoteArgument("powershell", path), `'${path}'`);
  assert.equal(quoteArgument("git-bash", "/c/Program Files/Ünicode/claude"), "'/c/Program Files/Ünicode/claude'");
  assert.equal(quoteArgument("powershell", "it's here"), "'it''s here'");
  assert.equal(quoteArgument("git-bash", "it's here"), "'it'\\''s here'");
  assert.equal(
    buildCommandLine("powershell", [path], ["--session-id", sessionId]),
    `& '${path}' --session-id ${sessionId}`,
  );

  for (const value of ['say "hi"', "line\nbreak"]) {
    assert.throws(
      () => quoteArgument("powershell", value),
      (error: unknown) => error instanceof ShellQuotingError,
    );
  }
  assert.equal(quoteArgument("git-bash", 'say "hi"'), `'say "hi"'`);
});

test("builds shell-safe project-root cd commands", () => {
  assert.equal(
    buildChangeDirectoryCommandLine("powershell", "C:\\Users\\emb\\dev\\aboard"),
    "cd -LiteralPath 'C:\\Users\\emb\\dev\\aboard'",
  );
  assert.equal(
    buildChangeDirectoryCommandLine("git-bash", "/c/Users/emb/dev/aboard"),
    "cd -- /c/Users/emb/dev/aboard",
  );
  assert.equal(
    buildChangeDirectoryCommandLine("cmd", "C:\\Users\\emb\\dev\\aboard"),
    'cd /d "C:\\Users\\emb\\dev\\aboard"',
  );
});

test("uses a launch executable path with spaces without breaking the plan", () => {
  const plan = planLaunch(
    request({ command: ["C:\\Program Files\\claude\\claude.exe"], prompt: "Go." }),
  );
  assert.equal(
    plan.commandLine,
    `& 'C:\\Program Files\\claude\\claude.exe' --session-id ${sessionId} ${definitionFlags("implementer")} --disable-slash-commands Go.`,
  );
});

test("a wrapper command keeps its own arguments ahead of every aboard flag", () => {
  const plan = planLaunch(request({ command: ["wrapper", "run", "MyProfile", "--"], prompt: "Go." }));
  assert.deepEqual(plan.command, ["wrapper", "run", "MyProfile", "--"]);
  assert.equal(
    plan.commandLine,
    `& wrapper run MyProfile -- --session-id ${sessionId} ${definitionFlags("implementer")} --disable-slash-commands Go.`,
  );
});

test("refuses a launch command that is empty or unrepresentable, and defaults to claude", () => {
  assert.deepEqual(planLaunch(request({ prompt: "Go." })).command, ["claude"]);
  assert.deepEqual(planLaunch(request({ command: [], prompt: "Go." })).command, ["claude"]);
  for (const command of [[" "], ['say "hi"'], ["line\nbreak"]]) {
    assert.throws(
      () => planLaunch(request({ command, prompt: "Go." })),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-command",
      JSON.stringify(command),
    );
  }
});

test("a definition's command replaces the configured launch command for that agent alone", () => {
  const configuration = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredCommand: ["wrapper", "run", "MyProfile", "--"],
  });
  const plan = planLaunch(
    request({ configuration, command: ["claude"], prompt: "Go." }),
  );
  assert.deepEqual(plan.command, ["wrapper", "run", "MyProfile", "--"]);
  assert.equal(
    plan.commandLine,
    `& wrapper run MyProfile -- --session-id ${sessionId} ${definitionFlags("implementer")} --disable-slash-commands Go.`,
  );
  // The flags aboard passes are untouched by the override: only the program
  // in front of them changes.
  assert.deepEqual(plan.args.slice(0, 2), ["--session-id", sessionId]);

  // An agent that declares nothing still launches on the setting.
  assert.deepEqual(
    planLaunch(request({ command: ["openclaude"], prompt: "Go." })).command,
    ["openclaude"],
  );

  // `--resume` reads no definition, so the override has to be re-applied by the
  // planner or a resumed agent would come back on the wrong CLI.
  assert.deepEqual(
    planSessionResume({
      agentId, sessionId, agentType: "implementer", shell: "powershell",
      configuration, command: ["claude"],
    }).command,
    ["wrapper", "run", "MyProfile", "--"],
  );
  const manager = planManagerResume({
    agentId, sessionId, shell: "powershell", command: ["claude"],
    configuration: definition("manager", MANAGER_TOOLS, { declaredCommand: ["wrapper", "run", "MyProfile", "--"] }),
  });
  assert.match(manager.commandLine, new RegExp(`^& wrapper run MyProfile -- --resume ${sessionId} `));

  // The wrapper still owns the outermost program; the override is what it runs.
  const wrapped = planLaunch(request({
    configuration, prompt: "Go.",
    wrapper: { script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py", lockPathFor: () => "C:\\repo\\lock" },
  }));
  assert.ok(wrapped.commandLine.includes("'C:\\repo\\lock' --request .aboard/runtime/agents/a1b2c3/launch.json"));
  assert.deepEqual(JSON.parse(wrapped.wrapperRequest!.contents), { command: ["wrapper", "run", "MyProfile", "--", ...wrapped.args] });
});

test("a declared command is validated like the setting, and requires a definition or builtin profile", () => {
  // `--` is a legal token here — it is how a wrapper ends its own arguments —
  // while an empty or unquotable one would launch the wrong program.
  for (const command of [[" "], ['say "hi"'], ["line\nbreak"]]) {
    assert.throws(
      () => planLaunch(request({
        configuration: definition("implementer", IMPLEMENTER_TOOLS, { declaredCommand: command }),
        prompt: "Go.",
      })),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "invalid-command",
      JSON.stringify(command),
    );
  }
  // An empty list is the frontmatter spelling of "no override", like
  // `model: inherit`, rather than a launch with no program.
  const empty = definition("implementer", IMPLEMENTER_TOOLS, { declaredCommand: [] });
  assert.equal("declaredCommand" in empty, false);
  assert.deepEqual(planLaunch(request({ configuration: empty, command: ["openclaude"], prompt: "Go." })).command, ["openclaude"]);

  assert.deepEqual(resolveLaunchConfiguration({ agentName: "Explore", declaredCommand: ["wrapper"] }), {
    shape: "builtin", agentName: "Explore", declaredCommand: ["wrapper"],
  });
  assert.throws(
    () => resolveLaunchConfiguration({ declaredCommand: ["wrapper"] }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
  );
});

test("parses the launch command setting as tokens, from a string or an array", () => {
  const tokens = (value: unknown) => {
    const parsed = parseClaudeCommand(value);
    return parsed.ok ? parsed.value : parsed.reason;
  };
  assert.deepEqual(tokens("claude"), ["claude"]);
  assert.deepEqual(tokens("  wrapper run MyProfile --  "), ["wrapper", "run", "MyProfile", "--"]);
  assert.deepEqual(tokens(["wrapper", "run", "MyProfile", "--"]), ["wrapper", "run", "MyProfile", "--"]);
  // Quotes group a token, so a program path with spaces survives the string form.
  assert.deepEqual(tokens('"C:\\tools\\my claude.exe" run --'), ["C:\\tools\\my claude.exe", "run", "--"]);
  assert.deepEqual(tokens("'my claude' --profile 'a b'"), ["my claude", "--profile", "a b"]);
  for (const rejected of ["", "   ", '"unterminated', [], [42], 7]) {
    assert.equal(typeof tokens(rejected), "string", JSON.stringify(rejected));
  }
});

test("requires a minted session id and a file-safe agent id", () => {
  assert.throws(
    () => planLaunch(request({ sessionId: "not-a-uuid" as SessionId })),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.code === "invalid-session-id",
  );
  assert.throws(
    () => planLaunch(request({ agentId: "../escape" as AgentId })),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "unsafe-agent-id",
  );
});

test("describes a plan without leaking prompt content", () => {
  const prompt = resolvedPromptFromText("Address issue #47.\nThe secret token is hunter2.");
  const description = describeLaunchPlan(planLaunch(request({ prompt })), prompt);

  assert.equal(description.includes("hunter2"), false);
  assert.equal(description.includes("delivery=spilled"), true);
  assert.equal(description.includes("lease=required"), true);
  assert.equal(
    describeLaunchPlan(planLaunch(request({ prompt: "Address issue #47." }))).includes(
      "delivery=inline",
    ),
    true,
  );
});

test("writes spill files under the workspace runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-spill-"));
  const store = new FileSystemPromptSpillStore(root);
  const plan = planLaunch(request({ prompt: "line one\nline two" }));
  assert.ok(plan.spill !== undefined);

  const path = await store.write(plan.spill);
  assert.equal(path, join(root, ".aboard", "runtime", "prompts", "a1b2c3.md"));
  assert.equal(await readFile(path, "utf8"), "line one\nline two\n");

  await assert.rejects(
    () => store.write({ ...plan.spill!, relativePath: "../outside.md" }),
    (error: unknown) => error instanceof PromptSpillPathError,
  );
});

test("runtime bundles give every launch done and reserve Manager commands for Manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-bundle-"));
  await cp(join(process.cwd(), "assets", "scaffold", ".aboard"), join(root, ".aboard"), { recursive: true });
  const store = new FileSystemPromptSpillStore(root);
  const manager = planLaunch(request({ agentType: "manager", configuration: definition("manager", MANAGER_TOOLS), prompt: undefined }));
  await store.prepare(manager);
  assert.deepEqual((await readdir(join(root, manager.runtimeDirectory, ".claude", "skills"))).sort(), [
    "auto", "brainstorm", "done", "general-purpose", "reopen", "review-pr", "update-todo",
  ]);
  const worker = planLaunch(request({ agentId: "worker-2" as AgentId }));
  await store.prepare(worker);
  assert.deepEqual(await readdir(join(root, worker.runtimeDirectory, ".claude", "skills")), ["done"]);
  assert.equal((JSON.parse(await readFile(join(root, worker.runtimeDirectory, "settings.json"), "utf8")) as { hooks?: unknown }).hooks !== undefined, true);
});

test("derives write capability from the effective tool set", () => {
  assert.equal(deriveWriteCapability(IMPLEMENTER_TOOLS), "write-capable");
  assert.equal(deriveWriteCapability(READ_ONLY_TOOLS), "read-only");
  assert.equal(deriveWriteCapability(BRAINSTORMER_TOOLS), "write-capable");
  assert.equal(deriveWriteCapability(undefined), "write-capable");
  assert.equal(deriveWriteCapability(["Read", "Bash"]), "write-capable");
  assert.equal(deriveWriteCapability(["Read", "PowerShell(git status)"]), "read-only");
  assert.equal(deriveWriteCapability(["Read", "Bash(*)"]), "write-capable");
  assert.equal(deriveWriteCapability(["*"]), "write-capable");
  // Unparseable frontmatter resolves to the restrictive answer.
  assert.equal(deriveWriteCapability(["Bash(gh *"]), "write-capable");
  assert.equal(deriveWriteCapability([]), "read-only");
});

test("a prompt under the inline threshold still spills when the command line would be too long", async () => {
  // The threshold measures the prompt; the shell's limit applies to the whole
  // assembled line. A generous threshold must not be able to defeat it.
  const text = "Address issue #47. ".repeat(500);
  const plan = planLaunch(request({
    shell: "cmd",
    maxInlinePromptChars: 100_000,
    prompt: resolvedPromptFromText(text),
  }));

  assert.equal(plan.promptDelivery, "spilled");
  assert.ok(plan.commandLine.length <= MAX_COMMAND_LINE_CHARS.cmd, `command line was ${plan.commandLine.length} characters`);
  assert.match(plan.commandLine, /@\.aboard\/runtime\/prompts\/a1b2c3\.md/);
  assert.equal(plan.spill?.contents.trim(), text.trim());

  // The spilled file is what the agent actually reads, so it must round-trip.
  const root = await mkdtemp(join(tmpdir(), "aboard-spill-"));
  const path = await new FileSystemPromptSpillStore(root).write(plan.spill!);
  assert.equal((await readFile(path, "utf8")).trim(), text.trim());
});

test("quoting expansion counts toward the limit, not the raw prompt length", () => {
  // PowerShell doubles every apostrophe, so the line is longer than the prompt.
  const text = "it's ".repeat(4_000);
  const plan = planLaunch(request({ shell: "powershell", maxInlinePromptChars: 100_000, prompt: resolvedPromptFromText(text) }));
  assert.equal(plan.promptDelivery, "spilled");
  assert.ok(plan.commandLine.length <= MAX_COMMAND_LINE_CHARS.powershell);
});

test("a command line too long even with the prompt spilled is a typed refusal", () => {
  const denied = Array.from({ length: 900 }, (_, index) => `Bash(tool${index}-x *)`);
  let error: LaunchPlanError | undefined;
  try {
    planLaunch(request({
      agentType: "implementer",
      shell: "cmd",
      disallowedTools: denied,
    }));
  } catch (thrown) {
    error = thrown as LaunchPlanError;
  }

  assert.ok(error instanceof LaunchPlanError);
  assert.equal(error.code, "command-line-too-long");
  assert.match(error.message, /over the 8000 the cmd shell accepts/);
  assert.match(error.message, /Shorten the deny-tool list/);

  // The same 900-rule list as an *allowlist* now costs the command line
  // nothing, because it never reaches it.
  const wide = planLaunch(request({ agentType: "implementer", shell: "cmd", configuration: definition("implementer", denied) }));
  assert.ok(wide.commandLine.length < 8_000);
  assert.equal(wide.agentDefinition?.contents.includes("Bash(tool899-x *)"), true);
});

test("a long prompt is spilled once and the stub keeps its headline when it fits", () => {
  const prompt = resolvedPromptFromText("x".repeat(20_000));
  const plan = planLaunch(request({ shell: "git-bash", prompt }));
  assert.equal(plan.promptDelivery, "spilled");
  // The stub is the whole prompt argument; the body never reaches the line.
  assert.ok(!plan.commandLine.includes("x".repeat(100)));
  assert.equal(plan.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3.md");
});

// Permissions are the user's to manage: aboard never puts a permission flag on
// any command line, for any type, attended or not.
test("no launch carries a permission flag", () => {
  const worker = planLaunch(request());
  const attended = planLaunch(request({ attended: true }));
  const brainstorm = planLaunch(
    request({ agentType: "brainstormer", configuration: definition("brainstormer", BRAINSTORMER_TOOLS), prompt: undefined }),
  );
  const resumed = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS),
  });
  const managerResumed = planManagerResume({
    agentId, sessionId, shell: "powershell",
    configuration: definition("manager", MANAGER_TOOLS),
  });
  for (const plan of [worker, attended, brainstorm, resumed, managerResumed]) {
    assert.ok(!plan.args.includes("--dangerously-skip-permissions"));
    assert.ok(!plan.args.includes("--permission-mode"));
  }
});

test("--disable-slash-commands guards every unattended launch and never reaches an attended one", () => {
  const unattended = planLaunch(request());
  assert.ok(unattended.args.includes("--disable-slash-commands"));

  // Explicit attendance suppresses it, whatever the type would otherwise derive.
  const handedOff = planLaunch(request({ attended: true }));
  assert.ok(!handedOff.args.includes("--disable-slash-commands"));

  // The Manager and the always-interactive types never carry it, attended or not.
  const manager = planLaunch(
    request({ agentType: "manager", configuration: definition("manager", MANAGER_TOOLS), prompt: undefined }),
  );
  assert.ok(!manager.args.includes("--disable-slash-commands"));
  const brainstormer = planLaunch(
    request({
      agentType: "brainstormer",
      configuration: definition("brainstormer", BRAINSTORMER_TOOLS),
      prompt: undefined,
    }),
  );
  assert.ok(!brainstormer.args.includes("--disable-slash-commands"));

  // A resume re-passes it exactly as it re-passes every other launch flag.
  const resumedUnattended = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS),
  });
  assert.ok(resumedUnattended.args.includes("--disable-slash-commands"));
  const resumedAttended = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    configuration: definition("implementer", IMPLEMENTER_TOOLS), attended: true,
  });
  assert.ok(!resumedAttended.args.includes("--disable-slash-commands"));
  const managerResumed = planManagerResume({
    agentId, sessionId, shell: "powershell",
    configuration: definition("manager", MANAGER_TOOLS),
  });
  assert.ok(!managerResumed.args.includes("--disable-slash-commands"));
});
