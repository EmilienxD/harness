import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_INLINE_PROMPT_CHARS,
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
import { ShellQuotingError, buildCommandLine, quoteArgument } from "../src/claude/shell.js";
import { deriveWriteCapability } from "../src/domain/capability.js";
import type { AgentId, SessionId } from "../src/domain/contracts.js";

const agentId = "a1b2c3" as AgentId;
const sessionId = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" as SessionId;

const IMPLEMENTER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"];
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh *)", "Bash(git diff*)", "LSP"];
const BRAINSTORMER_TOOLS = ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Skill"];
const MANAGER_TOOLS = ["Read", "Grep", "Glob", "Bash", "Skill"];

/**
 * An aboard definition, which is now carried onto the command line in full: the
 * body as `--system-prompt-file` and `tools:` as `--tools`.
 */
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

/** The two flags every agent-defined launch and resume carries, in order. */
function definitionArgs(agentName: string, declaredTools: readonly string[]): readonly string[] {
  return [
    `--system-prompt-file=.aboard/runtime/agents/${agentName}.md`,
    `--tools=${declaredTools.join(",")}`,
  ];
}

function request(overrides: Partial<LaunchPlanRequest> = {}): LaunchPlanRequest {
  return {
    agentId,
    sessionId,
    agentType: "implementer",
    shell: "powershell",
    permissionMode: "bypass",
    configuration: definition("implementer", IMPLEMENTER_TOOLS),
    prompt: "Implement issue #47.",
    ...overrides,
  };
}

test("plans the Manager from its definition rather than a discoverable agent", () => {
  const plan = planLaunch(
    request({
      agentType: "manager",
      configuration: definition("manager", MANAGER_TOOLS),
      disallowedTools: ["Bash(git push*)"],
      permissionMode: "default",
      prompt: undefined,
      model: "opus",
    }),
  );

  // Persona, model, and tool set all live in .aboard/agents/manager.md, and all
  // three reach Claude Code as flags: nothing is registered under
  // .claude/agents/, so no other session in the workspace can see or spawn the
  // Manager. The allowlist's contents (no Agent, no session-task tools, the
  // delegation surface is a command, not a tool) are pinned in agent-definitions.test.ts.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("manager", MANAGER_TOOLS),
    "--disallowedTools=Bash(git push*)",
    "--model",
    "opus",
  ]);
  assert.equal(
    plan.commandLine,
    `& claude --session-id ${sessionId} --system-prompt-file=.aboard/runtime/agents/manager.md '--tools=Read,Grep,Glob,Bash,Skill' '--disallowedTools=Bash(git push*)' --model opus`,
  );
  // The file the command line reads is part of the plan, because a launch that
  // cannot write it is a launch that would silently start on Claude Code's own
  // default persona.
  assert.equal(plan.systemPrompt?.relativePath, ".aboard/runtime/agents/manager.md");
  assert.equal(plan.systemPrompt?.contents, "You are the manager.\n");
  assert.equal(plan.promptDelivery, "none");
  // The Manager orchestrates and is never a lease holder, even though its
  // tool list leaves unrestricted Bash in place (spec section 4.3.1).
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, false);
});

test("wrapper layout prefixes the launch and resume lines without reshaping the args", () => {
  const wrapper = {
    script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py",
    lockPathFor: (id: typeof agentId) => `C:\\repo\\.aboard\\runtime\\locks\\${id}.lock`,
  };
  const plan = planLaunch(request({ wrapper }));
  // plan.args keeps the claude-side view; only the command line changes.
  assert.equal(plan.args[2], "--system-prompt-file=.aboard/runtime/agents/implementer.md");
  assert.match(plan.commandLine, /^& uv run --no-project --no-managed-python 'C:\\repo\\\.aboard\\scripts\\aboard_wrapper\.py' /);
  assert.ok(plan.commandLine.includes(`'C:\\repo\\.aboard\\runtime\\locks\\${agentId}.lock' -- claude --session-id ${sessionId}`));

  const resumed = planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    permissionMode: "bypass", configuration: definition("implementer", IMPLEMENTER_TOOLS), wrapper,
  });
  assert.match(resumed.commandLine, /aboard_wrapper\.py' .* -- claude --resume/);
});

test("wrapper tokens are validated like the launch command", () => {
  const wrapper = {
    script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py",
    lockPathFor: () => 'has "quote".lock',
  };
  assert.throws(() => planSessionResume({
    agentId, sessionId, agentType: "implementer", shell: "powershell",
    permissionMode: "bypass", configuration: definition("implementer", IMPLEMENTER_TOOLS), wrapper,
  }), /Wrapper token/);
});

test("plans an agent-defined implementer and spills a multi-line prompt", () => {
  const prompt = resolvedPromptFromText(
    "Implement issue #47 — Add token refresh.\n\n## Issue #47\n\nRotate the token.",
  );
  const plan = planLaunch(request({ shell: "git-bash", prompt }));

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer", IMPLEMENTER_TOOLS),
    "--dangerously-skip-permissions",
    "Implement issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.",
  ]);
  assert.equal(
    plan.commandLine,
    `claude --session-id ${sessionId} --system-prompt-file=.aboard/runtime/agents/implementer.md '--tools=Read,Grep,Glob,Edit,Write,Bash,LSP,Agent,Skill' --dangerously-skip-permissions 'Implement issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.'`,
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
      permissionMode: "acceptEdits",
    }),
  );

  // No deny rule: `tools:` is the whole tool authority, and there is no
  // project-scoped MCP server whose tools an allowlist would fail to exclude.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("webresearcher", READ_ONLY_TOOLS),
    "--permission-mode",
    "acceptEdits",
    "Research current API pricing.",
  ]);
  assert.equal(plan.writeCapability, "read-only");
  assert.equal(plan.requiresWriteLease, false);
});

test("plans a raw launch with no agent definition, no prompt, and the write lease", () => {
  const plan = planLaunch(
    request({
      agentType: "raw",
      configuration: resolveLaunchConfiguration({}),
      prompt: undefined,
      permissionMode: "default",
    }),
  );

  assert.deepEqual(plan.args, ["--session-id", sessionId]);
  assert.equal(plan.commandLine, `& claude --session-id ${sessionId}`);
  assert.equal(plan.promptDelivery, "none");
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, true);
});

test("a configured raw tool set does not downgrade raw out of the lease", () => {
  const configuration = resolveLaunchConfiguration({ tools: ["Read", "Grep"] });
  assert.equal(deriveWriteCapability(["Read", "Grep"]), "read-only");
  assert.equal(launchWriteCapability("raw", configuration), "write-capable");
});

test("the builtin types carry Claude Code's own capabilities, not a derived guess", () => {
  // No scaffolded definition exists to derive from: general-purpose is Claude
  // Code's full-tool agent, and Explore is its read-only search agent — the
  // conservative fallback for an unreadable definition would wrongly put
  // Explore on the write lease.
  // A builtin is the only shape that still carries `--agent`: Claude Code owns
  // the definition, so there is nothing for aboard to read or to pass.
  const builtin = (name: string) => resolveLaunchConfiguration({ agentName: name });
  assert.equal(builtin("Explore").shape, "builtin");
  assert.equal(launchWriteCapability("Explore", builtin("Explore")), "read-only");
  assert.equal(launchWriteCapability("general-purpose", builtin("general-purpose")), "write-capable");

  const explore = planLaunch(request({
    agentType: "Explore",
    configuration: builtin("Explore"),
    prompt: "Map the auth flow.",
    permissionMode: "default",
  }));
  assert.equal(explore.requiresWriteLease, false);
  // Both resolve to --agent <builtin name> with no tool flags.
  assert.deepEqual(explore.args, ["--session-id", sessionId, "--agent", "Explore", "Map the auth flow."]);
});

test("passes the session effort level on every launch shape and refuses an unknown one", () => {
  const plan = planLaunch(request({ effort: "xhigh", permissionMode: "default" }));
  // --effort sits with the other session flags, before the positional prompt.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer", IMPLEMENTER_TOOLS),
    "--effort",
    "xhigh",
    "Implement issue #47.",
  ]);

  // A resume re-passes the definition's own flags too — see the resume test
  // below for why — so the session level only fills the gap it leaves.
  assert.deepEqual(
    planManagerResume({
      agentId, sessionId, shell: "powershell", permissionMode: "default", effort: "low",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args,
    ["--resume", sessionId, ...definitionArgs("manager", MANAGER_TOOLS), "--effort", "low"],
  );
  assert.deepEqual(
    planSessionResume({
      agentId,
      sessionId,
      agentType: "implementer",
      shell: "powershell",
      permissionMode: "bypass",
      configuration: definition("implementer", IMPLEMENTER_TOOLS),
      effort: "max",
    }).args,
    ["--resume", sessionId, ...definitionArgs("implementer", IMPLEMENTER_TOOLS), "--effort", "max", "--dangerously-skip-permissions"],
  );

  // Unset is the documented "inherit": no flag at all, so Claude Code's own
  // effortLevel setting keeps deciding.

  assert.equal(planLaunch(request()).args.includes("--effort"), false);
  assert.equal(
    planManagerResume({
      agentId, sessionId, shell: "powershell", permissionMode: "default",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args.includes("--effort"),
    false,
  );

  for (const level of EFFORT_LEVELS) {
    assert.equal(isEffortLevel(level), true);
    assert.deepEqual(planLaunch(request({ effort: level })).args.slice(4, 6), ["--effort", level]);
  }
  // The value reaches the planner from a settings file, where a typo is a user
  // mistake rather than a compile error, and Claude Code refuses the launch on
  // an unknown level.
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
  // Claude Code honors the full frontmatter only for a subagent spawn. A
  // main-thread `--agent` launch — every launch aboard makes — ignores `model:`
  // and `effort:`, so the planner reads them from the definition and passes the
  // flags itself, or the session silently runs at the user's global defaults.
  const configuration = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredModel: "opus",
    declaredEffort: "high",
  });
  const plan = planLaunch(
    request({ configuration, permissionMode: "default", model: "haiku", effort: "low" }),
  );
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    ...definitionArgs("implementer", IMPLEMENTER_TOOLS),
    "--model",
    "opus",
    "--effort",
    "high",
    "Implement issue #47.",
  ]);

  // Each field falls back independently: a definition that declares only one
  // leaves the setting deciding the other.
  assert.deepEqual(
    planLaunch(request({
      configuration: definition("brainstormer", BRAINSTORMER_TOOLS, { declaredModel: "opus" }),
      agentType: "brainstormer",
      permissionMode: "default",
      effort: "low",
    })).args.slice(4),
    ["--model", "opus", "--effort", "low", "Implement issue #47."],
  );

  // `model: inherit` is the definition declining to choose, which is no flag —
  // not a model literally named "inherit", which would fail the launch.
  const inherited = definition("implementer", IMPLEMENTER_TOOLS, { declaredModel: "inherit" });
  assert.equal("declaredModel" in inherited, false);
  assert.equal(
    planLaunch(request({ configuration: inherited, permissionMode: "default" })).args.includes("--model"),
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
      permissionMode: "default",
      configuration,
      model: "haiku",
      effort: "low",
    }).args,
    ["--resume", sessionId, ...definitionArgs("implementer", IMPLEMENTER_TOOLS), "--model", "opus", "--effort", "high"],
  );
  assert.deepEqual(
    planManagerResume({
      agentId, sessionId, shell: "powershell", permissionMode: "default", model: "opus",
      configuration: definition("manager", MANAGER_TOOLS),
    }).args,
    ["--resume", sessionId, ...definitionArgs("manager", MANAGER_TOOLS), "--model", "opus"],
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

test("rejects plans that mix --agent with inline configuration", () => {
  // `--agent` names a builtin, whose tool set is Claude Code's; a `--tools`
  // flag beside it would be a second authority over the same session, which is
  // exactly what the write lease cannot survive (spec section 5.1.1).
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

  // A builtin has no aboard definition, so it can declare none of its fields.
  for (const input of [
    { agentName: "Explore", declaredTools: ["Read"] },
    { agentName: "Explore", declaredModel: "opus" },
  ]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
    );
  }

  assert.throws(
    () => resolveLaunchConfiguration({ declaredTools: ["Read"] }),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
  );
});

test("refuses a definition that cannot produce a complete command line", () => {
  // An empty system prompt is the one failure Claude Code does not report: it
  // starts the session on its own default persona instead (verified against
  // 2.1.229), which for an aboard agent means default behavior under a tool
  // list it never chose.
  for (const empty of ["", "   ", "\n\n"]) {
    assert.throws(
      () => resolveLaunchConfiguration({ agentName: "implementer", systemPrompt: empty, declaredTools: ["Read"] }),
      (error: unknown) => error instanceof LaunchPlanError && error.code === "missing-system-prompt",
      `${JSON.stringify(empty)} must be refused as a system prompt`,
    );
  }

  // `--tools=` with nothing after it disables every tool rather than inheriting
  // one, so an empty allowlist is a refused launch, not a permissive one.
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

test("pins each launch shape to the agent types allowed to use it", () => {
  const rejects = (overrides: Partial<LaunchPlanRequest>): void => {
    assert.throws(
      () => planLaunch(request({ prompt: "Do the thing.", ...overrides })),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "shape-not-allowed",
    );
  };

  // raw has no definition to launch from; inline is its shape.
  rejects({ agentType: "raw", configuration: definition("manager", MANAGER_TOOLS) });

  // The Manager launches from its own definition and nothing else: no bare
  // inline launch (it would lose the persona), and no other agent name.
  rejects({ agentType: "manager", configuration: resolveLaunchConfiguration({}) });
  rejects({ agentType: "manager", configuration: definition("implementer", IMPLEMENTER_TOOLS) });

  // Every other type has a definition — aboard's or Claude Code's — and a bare
  // inline launch would leave it without persona and tool list alike.
  for (const agentType of ["webresearcher", "implementer", "pr-doctor-afk", "pr-doctor-hitl", "brainstormer", "Explore"] as const) {
    rejects({ agentType, configuration: resolveLaunchConfiguration({ tools: ["Read"] }) });
  }

  // `--agent` and an aboard definition cannot borrow each other's shape: only
  // Claude Code's builtins are named on the command line, and only aboard's own
  // agents are carried on it.
  rejects({ agentType: "Explore", configuration: definition("Explore", ["Read"]) });
  rejects({ agentType: "implementer", configuration: resolveLaunchConfiguration({ agentName: "implementer" }) });

  // The one allowed pairing per side: raw inline, and the Manager from its file.
  const raw = planLaunch(request({ agentType: "raw", configuration: resolveLaunchConfiguration({ tools: ["Read"] }) }));
  assert.deepEqual(raw.args.slice(2), ["--tools=Read", "--dangerously-skip-permissions", "Implement issue #47."]);
  const manager = planLaunch(request({
    agentType: "manager",
    configuration: definition("manager", MANAGER_TOOLS),
    prompt: undefined,
    permissionMode: "default",
  }));
  assert.deepEqual(manager.args, ["--session-id", sessionId, ...definitionArgs("manager", MANAGER_TOOLS)]);
});

test("a resume re-passes every flag that shaped the launch", () => {
  // `--resume` restores the conversation and nothing else. Verified against
  // Claude Code 2.1.229: a session started with `--system-prompt-file` and
  // `--tools` comes back on the default persona holding the *full* default tool
  // set — Edit, Write, unrestricted Bash — unless both flags are repeated. A
  // read-only worker resumed that way would hold powers its lease never covered.
  const configuration = definition("webresearcher", READ_ONLY_TOOLS);
  const resumed = planSessionResume({
    agentId,
    sessionId,
    agentType: "webresearcher",
    shell: "powershell",
    permissionMode: "default",
    configuration,
  });
  assert.deepEqual(resumed.args, [
    "--resume",
    sessionId,
    ...definitionArgs("webresearcher", READ_ONLY_TOOLS),
  ]);
  // The system prompt file is rewritten on every resume, since nothing
  // guarantees the runtime directory survived between sessions.
  assert.equal(resumed.systemPrompt?.relativePath, ".aboard/runtime/agents/webresearcher.md");
  // Capability is derived from the configuration the command line actually
  // carries rather than accepted from the caller, so it cannot describe a
  // session other than this one.
  assert.equal(resumed.writeCapability, "read-only");
  assert.equal(resumed.requiresWriteLease, false);

  // A builtin keeps `--agent`, which `--resume` does restore, and raw carries
  // only the optional restriction it was launched with.
  assert.deepEqual(
    planSessionResume({
      agentId, sessionId, agentType: "Explore", shell: "powershell", permissionMode: "default",
      configuration: resolveLaunchConfiguration({ agentName: "Explore" }),
    }).args,
    ["--resume", sessionId],
  );
  assert.deepEqual(
    planSessionResume({
      agentId, sessionId, agentType: "raw", shell: "powershell", permissionMode: "default",
      configuration: resolveLaunchConfiguration({ tools: ["Read", "Grep"] }),
    }).args,
    ["--resume", sessionId, "--tools=Read,Grep"],
  );

  // The Manager resumes from its own definition or not at all.
  assert.throws(
    () => planManagerResume({
      agentId, sessionId, shell: "powershell", permissionMode: "default",
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

test("uses a launch executable path with spaces without breaking the plan", () => {
  const plan = planLaunch(
    request({ command: ["C:\\Program Files\\claude\\claude.exe"], prompt: "Go." }),
  );
  assert.equal(
    plan.commandLine,
    `& 'C:\\Program Files\\claude\\claude.exe' --session-id ${sessionId} --system-prompt-file=.aboard/runtime/agents/implementer.md '--tools=Read,Grep,Glob,Edit,Write,Bash,LSP,Agent,Skill' --dangerously-skip-permissions Go.`,
  );
});

test("a wrapper command keeps its own arguments ahead of every aboard flag", () => {
  // `clauder run kiro --` starts Claude Code on a named profile, where the
  // tokens before `--` are the wrapper's. aboard appends to them and changes
  // nothing about how its own flags are passed.
  const plan = planLaunch(request({ command: ["clauder", "run", "kiro", "--"], prompt: "Go." }));
  assert.deepEqual(plan.command, ["clauder", "run", "kiro", "--"]);
  assert.equal(
    plan.commandLine,
    `& clauder run kiro -- --session-id ${sessionId} --system-prompt-file=.aboard/runtime/agents/implementer.md '--tools=Read,Grep,Glob,Edit,Write,Bash,LSP,Agent,Skill' --dangerously-skip-permissions Go.`,
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
  // The per-agent override of `aboard.launch.claudeCommand`: one agent behind a
  // provider wrapper while the rest of the fleet keeps the setting. Wrapper
  // arguments come first and aboard's flags are appended unchanged, exactly as
  // the setting behaves.
  const configuration = definition("implementer", IMPLEMENTER_TOOLS, {
    declaredCommand: ["clauder", "run", "kiro", "--"],
  });
  const plan = planLaunch(
    request({ configuration, command: ["claude"], permissionMode: "default", prompt: "Go." }),
  );
  assert.deepEqual(plan.command, ["clauder", "run", "kiro", "--"]);
  assert.equal(
    plan.commandLine,
    `& clauder run kiro -- --session-id ${sessionId} --system-prompt-file=.aboard/runtime/agents/implementer.md '--tools=${IMPLEMENTER_TOOLS.join(",")}' Go.`,
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
      permissionMode: "default", configuration, command: ["claude"],
    }).command,
    ["clauder", "run", "kiro", "--"],
  );
  const manager = planManagerResume({
    agentId, sessionId, shell: "powershell", permissionMode: "default", command: ["claude"],
    configuration: definition("manager", MANAGER_TOOLS, { declaredCommand: ["clauder", "run", "kiro", "--"] }),
  });
  assert.match(manager.commandLine, new RegExp(`^& clauder run kiro -- --resume ${sessionId} `));

  // The wrapper still owns the outermost program; the override is what it runs.
  const wrapped = planLaunch(request({
    configuration, prompt: "Go.", permissionMode: "default",
    wrapper: { script: "C:\\repo\\.aboard\\scripts\\aboard_wrapper.py", lockPathFor: () => "C:\\repo\\lock" },
  }));
  assert.ok(wrapped.commandLine.includes("'C:\\repo\\lock' -- clauder run kiro -- --session-id"));
});

test("a declared command is validated like the setting, and is meaningless without a definition", () => {
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

  // A builtin type has no aboard definition to declare anything from, and a raw
  // launch has no definition at all.
  for (const input of [
    { agentName: "Explore", declaredCommand: ["clauder"] },
    { declaredCommand: ["clauder"] },
  ]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
      JSON.stringify(input),
    );
  }
});

test("parses the launch command setting as tokens, from a string or an array", () => {
  const tokens = (value: unknown) => {
    const parsed = parseClaudeCommand(value);
    return parsed.ok ? parsed.value : parsed.reason;
  };
  assert.deepEqual(tokens("claude"), ["claude"]);
  assert.deepEqual(tokens("  clauder run kiro --  "), ["clauder", "run", "kiro", "--"]);
  assert.deepEqual(tokens(["clauder", "run", "kiro", "--"]), ["clauder", "run", "kiro", "--"]);
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
  const prompt = resolvedPromptFromText("Implement issue #47.\nThe secret token is hunter2.");
  const description = describeLaunchPlan(planLaunch(request({ prompt })), prompt);

  assert.equal(description.includes("hunter2"), false);
  assert.equal(description.includes("delivery=spilled"), true);
  assert.equal(description.includes("lease=required"), true);
  assert.equal(
    describeLaunchPlan(planLaunch(request({ prompt: "Implement issue #47." }))).includes(
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
  const text = "Implement issue #47. ".repeat(500);
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
  // Nothing is left to spill: the length is in the agent's own tool list.
  const tools = Array.from({ length: 900 }, (_, index) => `Bash(tool${index}-x *)`);
  let error: LaunchPlanError | undefined;
  try {
    planLaunch(request({
      agentType: "raw",
      shell: "cmd",
      prompt: undefined,
      configuration: resolveLaunchConfiguration({ tools }),
    }));
  } catch (thrown) {
    error = thrown as LaunchPlanError;
  }

  assert.ok(error instanceof LaunchPlanError);
  assert.equal(error.code, "command-line-too-long");
  assert.match(error.message, /over the 8000 the cmd shell accepts/);
  assert.match(error.message, /Shorten the agent's tool list/);
});

test("a long prompt is spilled once and the stub keeps its headline when it fits", () => {
  const prompt = resolvedPromptFromText("x".repeat(20_000));
  const plan = planLaunch(request({ shell: "git-bash", prompt }));
  assert.equal(plan.promptDelivery, "spilled");
  // The stub is the whole prompt argument; the body never reaches the line.
  assert.ok(!plan.commandLine.includes("x".repeat(100)));
  assert.equal(plan.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3.md");
});
