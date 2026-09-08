import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_RUN_WORKER_SKILLS,
  BY_DIFFICULTY,
  LaunchPlanError,
  autoRunWorkerConfiguration,
  difficultyLaunchPolicy,
  launchWriteCapability,
  parseClaudeCommand,
  planLaunch,
  planSessionResume,
  promptSpillRoot,
  resolveLaunchConfiguration,
  taskPromptPath,
  type LaunchPlanRequest,
  type SessionWrapperLayout,
} from "../src/claude/launch.js";
import type { AgentId, AgentType, SessionId } from "../src/domain/contracts.js";

const agentId = "agent-1" as AgentId;
const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const runtimeRoot = "C:\\storage\\aboard";

function request(overrides: Partial<LaunchPlanRequest> = {}): LaunchPlanRequest {
  return {
    agentId,
    sessionId,
    agentType: "implementer",
    shell: "powershell",
    configuration: autoRunWorkerConfiguration("implementer"),
    prompt: "Address issue #47.",
    runtimeDirectory: runtimeRoot,
    ...overrides,
  };
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] === value;
}

test("parses configured Claude commands without invoking a shell parser", () => {
  assert.deepEqual(parseClaudeCommand("uvx --from 'claude code' claude"), {
    ok: true,
    value: ["uvx", "--from", "claude code", "claude"],
  });
  assert.equal(parseClaudeCommand("claude '").ok, false);
  assert.equal(parseClaudeCommand([]).ok, false);
});

test("plans an unmodified interactive session without an initial prompt", () => {
  const plan = planLaunch(request({
    agentType: "interactive",
    configuration: resolveLaunchConfiguration({}),
    prompt: undefined,
    attended: true,
  }));

  assert.equal(plan.promptDelivery, "none");
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, true);
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.includes("--mcp-config"), false);
  assert.equal("agentDefinition" in plan, false);
});

test("plans Explore through Claude Code's builtin agent", () => {
  const configuration = resolveLaunchConfiguration({
    agentName: "Explore",
    declaredModel: "haiku",
    declaredEffort: "low",
  });
  const plan = planLaunch(request({
    agentType: "Explore",
    configuration,
    prompt: "Map the authentication flow.",
  }));

  assert.equal(configuration.shape, "builtin");
  assert.equal(hasPair(plan.args, "--agent", "Explore"), true);
  assert.equal(hasPair(plan.args, "--model", "haiku"), true);
  assert.equal(hasPair(plan.args, "--effort", "low"), true);
  assert.equal(plan.writeCapability, "read-only");
  assert.equal(plan.requiresWriteLease, false);
});

test("rejects generated custom agent definitions", () => {
  assert.throws(
    () => resolveLaunchConfiguration({ agentName: "custom", systemPrompt: "Do work", declaredTools: ["Read"] }),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("maps stable Auto Run worker types to Harness skills", () => {
  assert.deepEqual(AUTO_RUN_WORKER_SKILLS, { implementer: "implement", reviewer: "review-afk" });
  assert.equal(autoRunWorkerConfiguration("implementer").shape, "skill");
  assert.deepEqual(autoRunWorkerConfiguration("reviewer", "afk"), {
    shape: "skill",
    skillName: "review-afk",
    declaredModel: BY_DIFFICULTY,
    declaredEffort: BY_DIFFICULTY,
  });
  assert.deepEqual(autoRunWorkerConfiguration("reviewer", "hitl"), {
    shape: "skill",
    skillName: "review-hitl",
    declaredModel: BY_DIFFICULTY,
    declaredEffort: BY_DIFFICULTY,
  });
});

for (const [type, mode, invocation] of [
  ["implementer", undefined, "/implement"],
  ["reviewer", "afk", "/review-afk"],
  ["reviewer", "hitl", "/review-hitl"],
] as const) {
  test(`plans ${type}${mode === undefined ? "" : ` ${mode}`} as a literal skill invocation`, () => {
    const configuration = type === "implementer"
      ? autoRunWorkerConfiguration("implementer")
      : autoRunWorkerConfiguration("reviewer", mode);
    const plan = planLaunch(request({ agentType: type, configuration, difficulty: "basic" }));

    assert.match(plan.args.at(-1) ?? "", new RegExp(`^${invocation.replace("/", "\\/")} `));
    assert.equal(hasPair(plan.args, "--model", difficultyLaunchPolicy("basic").model), true);
    assert.equal(hasPair(plan.args, "--effort", difficultyLaunchPolicy("basic").effort), true);
    assert.equal(plan.task?.relativePath, taskPromptPath(runtimeRoot, agentId));
    assert.equal(plan.task?.contents, "Address issue #47.\n");
    assert.equal(plan.writeCapability, "write-capable");
    assert.equal("agentDefinition" in plan, false);
  });
}

test("requires a first prompt for skill launches", () => {
  assert.throws(
    () => planLaunch(request({ prompt: undefined })),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "missing-prompt",
  );
});

test("preserves immutable and isolation deny rules without MCP allowlisting", () => {
  const plan = planLaunch(request({
    disallowedTools: ["Bash(git push*)", "Bash(git push*)", "WebFetch"],
  }));

  assert.equal(hasPair(plan.args, "--disallowedTools", "Bash(git push*),WebFetch"), true);
  assert.equal(plan.args.includes("--allowedTools"), false);
  assert.equal(plan.args.includes("--mcp-config"), false);
});

test("spills long skill prompts and keeps the original task separately", () => {
  const prompt = "Investigate the boundary. ".repeat(100);
  const plan = planLaunch(request({ prompt, maxInlinePromptChars: 40 }));

  assert.equal(plan.promptDelivery, "spilled");
  assert.match(plan.args.at(-1) ?? "", /^\/implement .*@.*\.md/u);
  assert.equal(plan.spill?.contents, `${prompt.trim()}\n`);
  assert.equal(plan.task?.contents, `${prompt.trim()}\n`);
  assert.equal(
    plan.spill?.relativePath.startsWith(`${promptSpillRoot(runtimeRoot).replaceAll("\\", "/")}/${agentId}/`),
    true,
  );
});

test("uses a wrapper request to keep child argv out of terminal input", () => {
  const wrapper: SessionWrapperLayout = {
    script: "C:\\extension\\session_wrapper.py",
    lockPathFor: () => "C:\\storage\\aboard\\agents\\agent-1\\live.lock",
    mintLaunchCode: () => "launch-code",
  };
  const plan = planLaunch(request({ wrapper }));

  assert.deepEqual(plan.command, ["claude"]);
  assert.match(plan.commandLine, /session_wrapper\.py/u);
  assert.match(plan.commandLine, /--request/u);
  const child = JSON.parse(plan.wrapperRequest?.contents ?? "{}") as { command?: string[] };
  assert.equal(child.command?.[0], "claude");
  assert.equal(child.command?.includes("--session-id"), true);
  assert.equal(child.command?.at(-1), "/implement Address issue #47.");
});

test("resume restores policy and restrictions without re-expanding a skill", () => {
  const plan = planSessionResume({
    agentId,
    sessionId,
    agentType: "reviewer",
    shell: "powershell",
    configuration: autoRunWorkerConfiguration("reviewer", "afk"),
    runtimeDirectory: runtimeRoot,
    prompt: "Continue",
    disallowedTools: ["Bash(git push*)"],
    difficulty: "advanced",
  });

  assert.equal(hasPair(plan.args, "--resume", sessionId), true);
  assert.equal(plan.args.some((argument) => argument.includes("/review-afk")), false);
  assert.equal(hasPair(plan.args, "--disallowedTools", "Bash(git push*)"), true);
  assert.equal(plan.args.includes("--mcp-config"), false);
  assert.equal("agentDefinition" in plan, false);
});

test("Chrome is available only to implementers and is replayed on resume", () => {
  assert.equal(planLaunch(request({ chrome: true })).args.includes("--chrome"), true);
  assert.throws(
    () => planLaunch(request({
      agentType: "reviewer",
      configuration: autoRunWorkerConfiguration("reviewer", "hitl"),
      chrome: true,
    })),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("launch capability follows the stable public role", () => {
  const cases: readonly [AgentType, ReturnType<typeof resolveLaunchConfiguration> | ReturnType<typeof autoRunWorkerConfiguration>, string][] = [
    ["interactive", resolveLaunchConfiguration({}), "write-capable"],
    ["Explore", resolveLaunchConfiguration({ agentName: "Explore" }), "read-only"],
    ["implementer", autoRunWorkerConfiguration("implementer"), "write-capable"],
    ["reviewer", autoRunWorkerConfiguration("reviewer"), "write-capable"],
  ];
  for (const [type, configuration, expected] of cases) {
    assert.equal(launchWriteCapability(type, configuration), expected);
  }
});
