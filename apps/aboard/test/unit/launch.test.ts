import assert from "node:assert/strict";
import test from "node:test";

import {
  difficultyLaunchPolicy,
  launchWriteCapability,
  planLaunch,
  planSessionResume,
  type LaunchConfiguration,
  type LaunchPlanRequest,
} from "../../src/claude/launch.js";
import {
  BY_DIFFICULTY,
  LaunchPlanError,
  promptSpillRoot,
  taskPromptPath,
  type SessionWrapperLayout,
} from "../../src/platform/launch.js";
import type { AgentId, AgentType, SessionId } from "../../src/domain/contracts.js";

const agentId = "agent-1" as AgentId;
const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const runtimeRoot = "C:\\storage\\aboard";

function workerConfiguration(type: "address" | "review"): LaunchConfiguration {
  return {
    shape: "skill",
    skillName: type === "address" ? "address-this" : "review-this",
    declaredModel: BY_DIFFICULTY,
    declaredEffort: BY_DIFFICULTY,
  };
}

function request(overrides: Partial<LaunchPlanRequest> = {}): LaunchPlanRequest {
  return {
    agentId,
    sessionId,
    agentType: "address",
    shell: "powershell",
    configuration: workerConfiguration("address"),
    prompt: "Address issue #47.",
    runtimeDirectory: runtimeRoot,
    ...overrides,
  };
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] === value;
}

test("plans an unmodified interactive session without an initial prompt", () => {
  const plan = planLaunch(request({
    agentType: "interactive",
    configuration: { shape: "default" },
    prompt: undefined,
    attended: true,
  }));

  assert.equal(plan.promptDelivery, "none");
  assert.deepEqual(plan.providerEnvironment, { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "1000000" });
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, false);
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.includes("--mcp-config"), false);
  assert.equal("agentDefinition" in plan, false);
});

test("a delegated Claude skill preserves its invocation and caller-supplied text", () => {
  const plan = planLaunch(request({
    agentType: "websearch",
    configuration: { shape: "default" },
    prompt: "Check /api and report primary sources.",
    skill: "websearch",
    attended: true,
  }));

  assert.equal(plan.args.at(-1), "/websearch Check /api and report primary sources.");
});

test("user-authored Claude prompts preserve slash-prefixed text", () => {
  const plan = planLaunch(request({
    agentType: "interactive",
    configuration: { shape: "default" },
    prompt: "Discuss /review and /api without invoking either.",
    attended: true,
  }));

  assert.equal(plan.args.at(-1), "Discuss /review and /api without invoking either.");
});

test("Auto Run Claude prompts preserve slash-prefixed text", () => {
  const plan = planLaunch(request({
    prompt: "Address /api without invoking /review.",
  }));

  assert.equal(plan.args.at(-1), "/address-this Address /api without invoking /review.");
});

test("plans explore through Claude Code's builtin Explore agent", () => {
  const configuration: LaunchConfiguration = {
    shape: "builtin",
    agentName: "Explore",
    declaredModel: "haiku",
    declaredEffort: "low",
  };
  const plan = planLaunch(request({
    agentType: "explore",
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

test("Auto Run exploration is planned as a headless print-mode execution", () => {
  const plan = planLaunch(request({
    agentType: "explore",
    configuration: { shape: "builtin", agentName: "Explore" },
    prompt: "Map the authentication flow.",
    executionMode: "auto-run",
  }));

  assert.deepEqual(plan.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
});

for (const kind of ["launch", "resume"] as const) {
  for (const type of ["address", "review"] as const) {
    test(`an Auto Run ${type} ${kind} keeps its interactive session instead of print mode`, () => {
      const planned = request({ agentType: type, configuration: workerConfiguration(type), executionMode: "auto-run" });
      const plan = kind === "launch" ? planLaunch(planned) : planSessionResume(planned);

      assert.equal(plan.args.includes("-p"), false);
      assert.equal(plan.args.includes("--output-format"), false);
    });
  }
}

for (const [type, invocation] of [
  ["address", "/address-this"],
  ["review", "/review-this"],
] as const) {
  test(`plans ${type} as a literal skill invocation`, () => {
    const configuration = workerConfiguration(type);
    const plan = planLaunch(request({ agentType: type, configuration, difficulty: "basic" }));

    assert.match(plan.args.at(-1) ?? "", new RegExp(`^${invocation.replace("/", "\\/")} `));
    assert.equal(hasPair(plan.args, "--model", difficultyLaunchPolicy("basic").model), true);
    assert.equal(hasPair(plan.args, "--effort", difficultyLaunchPolicy("basic").effort), true);
    assert.equal(plan.task?.relativePath, taskPromptPath(runtimeRoot, agentId));
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
    configuration: { ...workerConfiguration("address"), deniedTools: ["Agent", "WebSearch", "WebFetch"] },
    restrictions: { deniedCommands: ["git push*", "git push*"], denyWeb: true },
  }));

  assert.equal(hasPair(plan.args, "--disallowedTools", "Agent,WebSearch,WebFetch,Bash(git push*)"), true);
  assert.equal(plan.args.includes("--allowedTools"), false);
  assert.equal(plan.args.includes("--mcp-config"), false);
});

test("Claude rejects protected paths its comma-delimited deny flag cannot encode", () => {
  assert.throws(
    () => planLaunch(request({ restrictions: { protectedPaths: ["C:\\projects\\with,comma"] } })),
    (error: unknown) => error instanceof LaunchPlanError
      && error.code === "invalid-tool-rule"
      && /Claude.*comma/u.test(error.message),
  );
});

test("spills long skill prompts and keeps the original task separately", () => {
  const prompt = "Investigate the boundary. ".repeat(100);
  const promptRoot = "C:/Temp/abd-K7M2Q1";
  const plan = planLaunch(request({ prompt, promptRoot, maxInlinePromptChars: 40 }));

  assert.equal(plan.promptDelivery, "spilled");
  assert.match(plan.args.at(-1) ?? "", /^\/address-this .*@.*\.md/u);
  assert.equal(plan.spill?.relativePath, "C:/Temp/abd-K7M2Q1/agent-1/task.md");
  assert.equal(plan.task?.relativePath, plan.spill?.relativePath);
});

test("names the Claude session after its fleet agent label", () => {
  const plan = planLaunch(request({ agentId: "7" as AgentId, agentType: "review", configuration: workerConfiguration("review") }));

  assert.equal(hasPair(plan.args, "--name", "aboard-review-7"), true);
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
  assert.equal(child.command?.at(-1), "/address-this Address issue #47.");
});

test("resume restores policy and restrictions without re-expanding a skill", () => {
  const plan = planSessionResume({
    agentId,
    sessionId,
    agentType: "review",
    shell: "powershell",
    configuration: workerConfiguration("review"),
    runtimeDirectory: runtimeRoot,
    prompt: "Continue",
    restrictions: { deniedCommands: ["git push*"] },
    difficulty: "advanced",
  });

  assert.equal(hasPair(plan.args, "--resume", sessionId), true);
  assert.equal(plan.args.some((argument) => argument.includes("/review-this")), false);
  assert.equal(hasPair(plan.args, "--disallowedTools", "Bash(git push*)"), true);
  assert.equal(plan.args.includes("--mcp-config"), false);
  assert.equal("agentDefinition" in plan, false);
});

test("spilled continuation prompts use short fresh names under the activation root", () => {
  const plan = planSessionResume({
    agentId,
    sessionId,
    agentType: "review",
    shell: "powershell",
    configuration: workerConfiguration("review"),
    runtimeDirectory: runtimeRoot,
    promptRoot: "C:/Temp/abd-K7M2Q1",
    prompt: "Continue with the review context. ".repeat(100),
    maxInlinePromptChars: 40,
  });

  assert.equal(plan.promptDelivery, "spilled");
  assert.match(plan.spill?.relativePath ?? "", /^C:\/Temp\/abd-K7M2Q1\/agent-1\/c-[0-9a-f]{16}\.md$/u);
});

test("Chrome is available to both auto-run workers and is replayed on resume", () => {
  const review = request({
    agentType: "review",
    configuration: workerConfiguration("review"),
    chrome: true,
  });

  assert.equal(planLaunch(request({ chrome: true })).args.includes("--chrome"), true);
  assert.equal(planLaunch(review).args.includes("--chrome"), true);
  assert.equal(planSessionResume(review).args.includes("--chrome"), true);
  // The label is an issue's property, so a session outside auto-run cannot ask
  // for the browser by claiming it.
  assert.throws(
    () => planLaunch(request({
      agentType: "interactive",
      configuration: { shape: "default" },
      chrome: true,
    })),
    (error: unknown) => error instanceof LaunchPlanError && error.code === "shape-not-allowed",
  );
});

test("launch capability follows the stable public type", () => {
  const cases: readonly [AgentType, LaunchConfiguration, string][] = [
    ["interactive", { shape: "default" }, "write-capable"],
    ["explore", { shape: "builtin", agentName: "Explore" }, "read-only"],
    ["address", workerConfiguration("address"), "write-capable"],
    ["review", workerConfiguration("review"), "write-capable"],
  ];
  for (const [type, configuration, expected] of cases) {
    assert.equal(launchWriteCapability(type, configuration), expected);
  }
});
