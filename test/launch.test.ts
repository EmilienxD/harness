import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_INLINE_PROMPT_CHARS,
  LaunchPlanError,
  MANAGER_TOOL_PRESET_TOOLS,
  describeLaunchPlan,
  launchWriteCapability,
  planLaunch,
  planResume,
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
const REVIEWER_TOOLS = ["Read", "Grep", "Glob", "Bash(gh *)", "Bash(git diff*)", "LSP"];
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

test("plans the Manager as an inline launch with a tool preset and no Agent tool", () => {
  const plan = planLaunch(
    request({
      agentType: "manager",
      configuration: resolveLaunchConfiguration({
        tools: [...MANAGER_TOOL_PRESET_TOOLS["read-only"]],
      }),
      disallowedTools: ["Bash(git push*)"],
      permissionMode: "default",
      prompt: undefined,
      model: "opus",
    }),
  );

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    "--tools",
    "aboard__*",
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "Skill",
    "AskUserQuestion",
    "--disallowedTools",
    "Bash(git push*)",
    "--model",
    "opus",
  ]);
  assert.equal(
    plan.commandLine,
    `& claude --session-id ${sessionId} --tools 'aboard__*' Read Grep Glob Bash Skill AskUserQuestion --disallowedTools 'Bash(git push*)' --model opus`,
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

test("plans a read-only reviewer that stays concurrent", () => {
  const plan = planLaunch(
    request({
      agentType: "reviewer",
      configuration: resolveLaunchConfiguration({
        agentName: "reviewer",
        declaredTools: REVIEWER_TOOLS,
      }),
      prompt: "Review pull request #42.",
      permissionMode: "acceptEdits",
    }),
  );

  assert.deepEqual(plan.args, [
    "--session-id",
    sessionId,
    "--agent",
    "reviewer",
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

test("resumes by CLI argument and re-passes bypass mode", () => {
  const plan = planResume({
    agentId,
    sessionId,
    agentType: "implementer",
    shell: "powershell",
    permissionMode: "bypass",
    writeCapability: "write-capable",
    sequence: 1,
    message: "Address the review comments on #42.",
  });

  assert.equal(plan.kind, "resume");
  assert.deepEqual(plan.args, [
    "--resume",
    sessionId,
    "--dangerously-skip-permissions",
    "Address the review comments on #42.",
  ]);
  // Resume never re-declares a launch shape, so the mutually exclusive pair
  // cannot be reintroduced on this path.
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.includes("--tools"), false);
});

test("each resumed message spills to its own retained file", () => {
  const message = `${"long ".repeat(1200)}end`;
  const first = planResume({
    agentId,
    sessionId,
    agentType: "brainstormer",
    shell: "git-bash",
    permissionMode: "default",
    writeCapability: "read-only",
    sequence: 1,
    message,
  });
  const second = planResume({
    agentId,
    sessionId,
    agentType: "brainstormer",
    shell: "git-bash",
    permissionMode: "default",
    writeCapability: "read-only",
    sequence: 2,
    message,
  });

  assert.equal(first.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3-resume-1.md");
  assert.equal(second.spill?.relativePath, ".aboard/runtime/prompts/a1b2c3-resume-2.md");
  assert.notEqual(first.spill?.relativePath, second.spill?.relativePath);
});

test("rejects a resume with no message", () => {
  assert.throws(
    () =>
      planResume({
        agentId,
        sessionId,
        agentType: "implementer",
        shell: "powershell",
        permissionMode: "default",
        writeCapability: "write-capable",
        sequence: 1,
        message: "   ",
      }),
    (error: unknown) =>
      error instanceof LaunchPlanError && error.code === "missing-message",
  );
});

test("rejects plans that mix --agent with inline configuration", () => {
  for (const input of [
    { agentName: "implementer", tools: ["Read"] },
    { agentName: "implementer", systemPrompt: "You orchestrate." },
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

test("rejects agent-defined launches for the Manager and for raw", () => {
  for (const agentType of ["manager", "raw"] as const) {
    assert.throws(
      () =>
        planLaunch(
          request({
            agentType,
            configuration: resolveLaunchConfiguration({ agentName: "manager" }),
            prompt: undefined,
          }),
        ),
      (error: unknown) =>
        error instanceof LaunchPlanError && error.code === "shape-not-allowed",
    );
  }
});

test("automated workers require a prompt and interactive workers do not", () => {
  for (const agentType of ["implementer", "reviewer", "fixer"] as const) {
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
    buildCommandLine("powershell", path, ["--session-id", sessionId]),
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
    request({ executable: "C:\\Program Files\\claude\\claude.exe", prompt: "Go." }),
  );
  assert.equal(
    plan.commandLine,
    `& 'C:\\Program Files\\claude\\claude.exe' --session-id ${sessionId} --agent implementer --dangerously-skip-permissions Go.`,
  );
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
  assert.equal(deriveWriteCapability(REVIEWER_TOOLS), "read-only");
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
