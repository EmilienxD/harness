import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_INLINE_PROMPT_CHARS,
  MAX_COMMAND_LINE_CHARS,
  LaunchPlanError,
  MANAGER_TOOL_PRESET_TOOLS,
  managerLaunchConfiguration,
  describeLaunchPlan,
  launchWriteCapability,
  parseClaudeCommand,
  planLaunch,
  resolveLaunchConfiguration,
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
const BRAINSTORMER_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(gh *)",
  "Agent",
  "Skill",
  "AskUserQuestion",
];

function request(overrides: Partial<LaunchPlanRequest> = {}): LaunchPlanRequest {
  return {
    agentId,
    sessionId,
    agentType: "implementer",
    shell: "powershell",
    permissionMode: "bypass",
    configuration: resolveLaunchConfiguration({
      agentName: "implementer",
      declaredTools: IMPLEMENTER_TOOLS,
    }),
    prompt: "Implement issue #47.",
    ...overrides,
  };
}

test("plans the Manager as --agent manager narrowed by a tool preset, with no Agent tool", () => {
  const plan = planLaunch(
    request({
      agentType: "manager",
      configuration: managerLaunchConfiguration("read-only"),
      disallowedTools: ["Bash(git push*)"],
      permissionMode: "default",
      prompt: undefined,
      model: "opus",
    }),
  );

  // The persona lives in .claude/agents/manager.md, which declares no `tools:`,
  // so the preset narrows an inherited pool instead of contradicting the file.
  // Tool lists are one comma-separated argument: the flags are variadic, so
  // separate values would swallow the positional prompt (claude --help:
  // "Bash,Edit,Read"). MCP tools surface as mcp__<server>__<tool>.
  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    "--agent",
    "manager",
    "--tools",
    "mcp__aboard__*,Read,Grep,Glob,Bash,Skill,AskUserQuestion",
    "--disallowedTools",
    "Bash(git push*)",
    "--model",
    "opus",
  ]);
  assert.equal(
    plan.commandLine,
    `& claude --session-id ${sessionId} --agent manager --tools 'mcp__aboard__*,Read,Grep,Glob,Bash,Skill,AskUserQuestion' --disallowedTools 'Bash(git push*)' --model opus`,
  );
  assert.equal(plan.promptDelivery, "none");
  // The Manager orchestrates and is never a lease holder, even though the
  // read-only preset leaves unrestricted Bash in place.
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, false);
});

test("neither Manager preset exposes the Agent or session-task tools", () => {
  for (const tools of Object.values(MANAGER_TOOL_PRESET_TOOLS)) {
    for (const forbidden of ["Agent", "Task", "TaskCreate", "TaskUpdate", "TodoWrite"]) {
      assert.equal(tools.includes(forbidden), false, `${forbidden} must be absent`);
    }
  }
});

test("plans an agent-defined implementer and spills a multi-line prompt", () => {
  const prompt = resolvedPromptFromText(
    "Implement issue #47 — Add token refresh.\n\n## Issue #47\n\nRotate the token.",
  );
  const plan = planLaunch(request({ shell: "git-bash", prompt }));

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    "--agent",
    "implementer",
    "--dangerously-skip-permissions",
    "Implement issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.",
  ]);
  assert.equal(
    plan.commandLine,
    `claude --session-id ${sessionId} --agent implementer --dangerously-skip-permissions 'Implement issue #47 — Add token refresh. Your full task is in @.aboard/runtime/prompts/a1b2c3.md — read it first.'`,
  );
  assert.equal(plan.promptDelivery, "spilled");
  assert.equal(plan.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3.md");
  assert.equal(plan.spill?.contents, `${prompt.text}\n`);
  assert.equal(plan.requiresWriteLease, true);
});

test("plans a read-only agent that stays concurrent", () => {
  const plan = planLaunch(
    request({
      agentType: "brainstormer",
      configuration: resolveLaunchConfiguration({
        agentName: "brainstormer",
        declaredTools: READ_ONLY_TOOLS,
      }),
      prompt: "Review pull request #42.",
      permissionMode: "acceptEdits",
    }),
  );

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    "--agent",
    "brainstormer",
    "--permission-mode",
    "acceptEdits",
    "Review pull request #42.",
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
  const builtin = (name: string) => resolveLaunchConfiguration({ agentName: name });
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

test("rejects plans that mix --agent with inline configuration", () => {
  for (const input of [
    { agentName: "implementer", tools: ["Read"] },
    { agentName: "manager", tools: MANAGER_TOOL_PRESET_TOOLS["read-only"] },
  ]) {
    assert.throws(
      () => resolveLaunchConfiguration(input),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "conflicting-launch-shape",
    );
  }

  assert.throws(
    () => resolveLaunchConfiguration({ declaredTools: ["Read"] }),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.code === "declared-tools-without-agent",
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

  // raw has no definition to launch from, and the Manager must not fall back to
  // a bare --tools launch that would leave it without its persona.
  rejects({ agentType: "raw", configuration: resolveLaunchConfiguration({ agentName: "manager" }) });
  rejects({ agentType: "manager", configuration: resolveLaunchConfiguration({ agentName: "manager" }) });
  rejects({
    agentType: "manager",
    configuration: resolveLaunchConfiguration({ tools: [...MANAGER_TOOL_PRESET_TOOLS["read-only"]] }),
  });

  // Every worker definition declares its own `tools:`, which the write lease
  // trusts; a preset alongside --agent would widen it behind the bridge's back.
  for (const agentType of ["implementer", "pr-doctor-afk", "pr-doctor-hitl", "brainstormer"] as const) {
    rejects({ agentType, configuration: managerLaunchConfiguration("read-only") });
  }
});

test("automated workers require a prompt and interactive workers do not", () => {
  for (const agentType of ["implementer", "pr-doctor-afk"] as const) {
    assert.throws(
      () =>
        planLaunch(
          request({
            agentType,
            configuration: resolveLaunchConfiguration({ agentName: agentType }),
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
      configuration: resolveLaunchConfiguration({
        agentName: "brainstormer",
        declaredTools: BRAINSTORMER_TOOLS,
      }),
      prompt: undefined,
    }),
  );
  assert.equal(brainstormer.promptDelivery, "none");
  assert.equal(brainstormer.requiresWriteLease, false);
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
    `& 'C:\\Program Files\\claude\\claude.exe' --session-id ${sessionId} --agent implementer --dangerously-skip-permissions Go.`,
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
    `& clauder run kiro -- --session-id ${sessionId} --agent implementer --dangerously-skip-permissions Go.`,
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
  assert.equal(deriveWriteCapability(BRAINSTORMER_TOOLS), "read-only");
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
