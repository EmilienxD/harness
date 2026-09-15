import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";

const agentId = "interactive-1" as AgentId;
const provisional = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const actual = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;

test("the ChatGPT adapter launches a visible Codex session without imposing its provisional id", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
  });

  assert.deepEqual(platform.createSession(), { sessionId: provisional, binding: "provisional" });
  assert.equal(platform.bindSession({ sessionId: provisional, binding: "provisional" }, actual), actual);
  assert.equal(platform.bindSession({ sessionId: actual, binding: "bound" }, provisional), undefined);

  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "interactive",
    shell: "powershell",
    configuration: { shape: "default", declaredCommand: ["wrapper", "codex"] },
    prompt: "Inspect the launch boundary.",
    runtimeDirectory: "C:/aboard/runtime",
  });

  assert.equal(plan.platform, "chatgpt");
  assert.deepEqual(plan.command, ["wrapper", "codex"]);
  assert.equal(plan.args.includes("--session-id"), false);
  assert.equal(plan.args.includes("--dangerously-bypass-hook-trust"), true);
  assert.deepEqual(plan.args.slice(-2), ["--", "Inspect the launch boundary."]);
  assert.equal(plan.args.at(-1), "Inspect the launch boundary.");
  assert.equal(plan.promptDelivery, "inline");
  assert.match(plan.args.join("\n"), /hooks\.SessionStart/u);
  assert.match(plan.args.join("\n"), /hooks\.SessionEnd/u);
});

test("the ChatGPT adapter protects option-shaped prompts from Codex argument parsing", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "interactive",
    shell: "powershell",
    configuration: { shape: "default", declaredCommand: ["codex"] },
    prompt: "--help is part of the task, not a CLI option.",
    runtimeDirectory: "C:/aboard/runtime",
  });

  assert.deepEqual(plan.args.slice(-2), ["--", "--help is part of the task, not a CLI option."]);
});

test("the ChatGPT adapter spills a large initial prompt", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
  });
  const prompt = "large prompt ".repeat(100);
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "interactive",
    shell: "powershell",
    configuration: { shape: "default", declaredCommand: ["codex"] },
    prompt,
    runtimeDirectory: "C:/aboard/runtime",
    maxInlinePromptChars: 20,
  });

  assert.equal(plan.promptDelivery, "spilled");
  assert.ok(plan.spill !== undefined);
  assert.match(plan.args.at(-1) ?? "", new RegExp(`@${plan.spill.relativePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
});

test("the ChatGPT adapter spills an inline-eligible prompt when the shell command would overflow", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const prompt = "shell-sized prompt ".repeat(1_600);
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "interactive",
    shell: "powershell",
    configuration: { shape: "default", declaredCommand: ["codex"] },
    prompt,
    runtimeDirectory: "C:/aboard/runtime",
    maxInlinePromptChars: 50_000,
  });

  assert.equal(plan.promptDelivery, "spilled");
});

test("the ChatGPT adapter normalizes Codex lifecycle payloads with the runtime session id", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });

  assert.deepEqual(platform.normalizeLifecycle("start", {
    agentId,
    session_id: actual,
    source: "startup",
  }), { type: "start", agentId, sessionId: actual, source: "startup" });
  assert.deepEqual(platform.normalizeLifecycle("stop", {
    agentId,
    session_id: actual,
    cwd: "C:/work",
    last_assistant_message: "Finished inspecting the boundary.",
  }), {
    type: "stop", agentId, sessionId: actual, cwd: "C:/work",
    lastAssistantMessage: "Finished inspecting the boundary.",
  });
  assert.deepEqual(platform.normalizeLifecycle("end", {
    agentId,
    session_id: actual,
    reason: "other",
  }), { type: "end", agentId, sessionId: actual, reason: "other" });
  assert.deepEqual(platform.normalizeLifecycle("compaction", {
    agentId,
    session_id: actual,
    trigger: "auto",
  }), { type: "compaction", agentId, sessionId: actual });
  assert.equal(platform.capabilities.lifecycle.includes("compaction"), true);
});

test("the ChatGPT adapter preflights the complete configured command and the session's policy needs", async () => {
  const calls: string[][] = [];
  const required: string[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async (program, args) => {
      calls.push([program, ...args]);
      return { code: 0, stdout: "codex-cli 0.153.4\n", stderr: "" };
    },
    policyProbe: { require: async (agentType) => { required.push(agentType); } },
  });
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "Explore",
    shell: "powershell",
    configuration: { shape: "explore", declaredCommand: ["wrapper", "run", "codex"] },
    prompt: "Report the implementation context for issue #14.",
    runtimeDirectory: "C:/aboard/runtime",
  });
  await platform.preflight(plan);
  assert.deepEqual(calls, [["wrapper", "run", "codex", "--version"]]);
  assert.deepEqual(required, ["Explore"]);
});

test("a ChatGPT Explore session preserves its shared prompt while Codex cannot let it write", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
  });

  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "Explore",
    shell: "powershell",
    configuration: { shape: "explore", declaredCommand: ["codex"], declaredModel: "gpt-test", declaredEffort: "low" },
    prompt: "Report the implementation context for issue #14.",
    runtimeDirectory: "C:/aboard/runtime",
  });

  assert.equal(plan.agentType, "Explore");
  assert.equal(plan.writeCapability, "read-only");
  assert.equal(plan.requiresWriteLease, false);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--sandbox"), plan.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(plan.args.includes('approval_policy="never"'), true);
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.at(-2), "--");
  assert.equal(plan.args.at(-1), "Report the implementation context for issue #14.");
});

test("a ChatGPT Explore session refuses to launch without an exploration task or as another shape", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const request = {
    agentId,
    sessionId: provisional,
    agentType: "Explore",
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
  } as const;

  assert.throws(
    () => platform.planLaunch({ ...request, configuration: { shape: "explore", declaredCommand: ["codex"] } }),
    /Explore cannot launch without its exploration task/u,
  );
  assert.throws(
    () => platform.planLaunch({ ...request, configuration: { shape: "default", declaredCommand: ["codex"] }, prompt: "Report the context." }),
    /Explore launches as a read-only Codex session/u,
  );
  assert.throws(
    () => platform.planLaunch({ ...request, agentType: "reviewer", configuration: { shape: "explore", declaredCommand: ["codex"] }, prompt: "Review the change." }),
    /reviewer must launch through \$review-this/u,
  );
});

test("a large ChatGPT Explore task uses spilled delivery", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "Explore",
    shell: "powershell",
    configuration: { shape: "explore", declaredCommand: ["codex"] },
    prompt: "exploration task ".repeat(100),
    runtimeDirectory: "C:/aboard/runtime",
    maxInlinePromptChars: 20,
  });

  assert.equal(plan.promptDelivery, "spilled");
});

test("the ChatGPT adapter resumes the exact Codex conversation with current launch policy", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planSessionResume({
    agentId,
    sessionId: actual,
    agentType: "interactive",
    shell: "powershell",
    configuration: {
      shape: "default",
      declaredCommand: ["wrapper", "codex"],
      declaredModel: "gpt-test",
      declaredEffort: "high",
    },
    prompt: "Continue from the saved state.",
    runtimeDirectory: "C:/aboard/runtime",
  });

  assert.equal(plan.kind, "resume");
  assert.deepEqual(plan.command, ["wrapper", "codex"]);
  assert.deepEqual(plan.args.slice(0, 2), ["resume", actual]);
  assert.equal(plan.args.includes("--model"), true);
  assert.equal(plan.args.includes("model_reasoning_effort=\"high\""), true);
  assert.deepEqual(plan.args.slice(-1), ["Continue from the saved state."]);
  assert.match(plan.args.join("\n"), /hooks\.SessionStart/u);
  assert.match(plan.args.join("\n"), /matcher="startup\|resume"/u);
  assert.equal(plan.args.filter((argument) => argument.startsWith("hooks.SessionStart=")).length, 1);
  assert.match(plan.args.join("\n"), /worker-reground/u);
});

const implementer = {
  agentId: "implementer-1" as AgentId,
  sessionId: provisional,
  agentType: "implementer",
  shell: "powershell",
  configuration: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" },
  runtimeDirectory: "C:/aboard/runtime",
} as const;

function chatGpt(options: Partial<ConstructorParameters<typeof ChatGptAgentPlatform>[0]> = {}): ChatGptAgentPlatform {
  return new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
    ...options,
  });
}

test("a ChatGPT implementer invokes the installed implement skill with the frozen issue context", () => {
  const plan = chatGpt().planLaunch({
    ...implementer,
    prompt: "The checked-out branch is for issue #15.",
    difficulty: "basic",
    restrictions: { deniedCommands: ["git commit*", "gh pr create*"], denySubagents: true, denyWeb: true },
  });

  assert.equal(plan.agentType, "implementer");
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, true);
  assert.deepEqual(plan.args.slice(-2), ["--", "$address-this The checked-out branch is for issue #15."]);
  assert.equal(plan.chromeRequired, undefined);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--model"), plan.args.indexOf("--model") + 2), ["--model", "gpt-5.6-terra"]);
  assert.equal(plan.args.includes('model_reasoning_effort="high"'), true);
});

test("a ChatGPT implementer keeps its skill invocation when the frozen contract spills to a file", () => {
  const promptRoot = "C:/Temp/abd-K7M2Q1";
  const plan = chatGpt().planLaunch({
    ...implementer,
    prompt: "frozen issue contract ".repeat(200),
    promptRoot,
    maxInlinePromptChars: 40,
  });

  assert.equal(plan.promptDelivery, "spilled");
  assert.match(plan.args.at(-1) ?? "", /^\$address-this Perform the task described in @/u);
  assert.equal(plan.spill?.relativePath, "C:/Temp/abd-K7M2Q1/implementer-1/task.md");
  assert.equal(plan.task?.relativePath, plan.spill?.relativePath);
});

test("a ChatGPT implementer cannot spawn subagents, search the web, or mutate Aboard-owned Git state", () => {
  const plan = chatGpt().planLaunch({
    ...implementer,
    autoRunRestricted: true,
    prompt: "Address the issue.",
    restrictions: { denySubagents: true, denyWeb: true, deniedCommands: ["git commit*", "gh pr merge*", "git commit*"], protectedPaths: ["C:/project"] },
  });

  assert.equal(plan.args.includes('web_search="disabled"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), true);
  assert.equal(plan.args.includes("agents.enabled=false"), true);
  assert.match(plan.args.join("\n"), /hooks\.PreToolUse=\[\{matcher="Bash\|Agent"/u);
  assert.equal(plan.guard?.relativePath, "C:/aboard/runtime/agents/implementer-1/guard.json");
  assert.deepEqual(JSON.parse(plan.guard?.contents ?? "{}"), {
    denySubagents: true,
    denyCommands: ["git commit*", "gh pr merge*"],
  });
});

test("an isolated ChatGPT worker requires a Codex version with permission profiles", async () => {
  const platform = chatGpt({
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.137.0", stderr: "" }),
    policyProbe: { require: async () => undefined },
  });
  const plan = platform.planLaunch({
    ...implementer,
    prompt: "Address the issue.",
    restrictions: { protectedPaths: ["C:/project"] },
  });

  await assert.rejects(platform.preflight(plan), /Codex 0\.138\.0 or later.*permission profile/u);
});

test("an isolated ChatGPT worker denies writes to the original checkout without denying reads", () => {
  const plan = chatGpt().planLaunch({
    ...implementer,
    prompt: "Address the issue.",
    restrictions: { protectedPaths: ["C:/project"] },
    writableRoots: ["C:\\project\\.git\\worktrees\\work", "C:\\project\\.git\\objects"],
  });
  const profile = plan.args.find((argument) => argument.startsWith("permissions.aboard-worktree=")) ?? "";

  // Codex takes native separators inside the path but needs the portable `/**`
  // suffix for a read subtree, and a POSIX checkout must keep its own separators.
  assert.ok(profile.includes(`${JSON.stringify("C:\\project/**")}="read"`));
  for (const metadata of ["C:\\project\\.git\\worktrees\\work", "C:\\project\\.git\\objects"]) {
    assert.ok(profile.includes(`${JSON.stringify(metadata)}=true`), metadata);
  }
  assert.ok(profile.includes(`":workspace_roots"={"."="write"}`));
  assert.doesNotMatch(profile, /="deny"/u);
});

test("a POSIX checkout keeps its own separators in the ChatGPT read subtree", () => {
  const plan = chatGpt().planLaunch({
    ...implementer,
    prompt: "Address the issue.",
    restrictions: { protectedPaths: ["/home/dev/project/"] },
  });
  const profile = plan.args.find((argument) => argument.startsWith("permissions.aboard-worktree=")) ?? "";

  assert.ok(profile.includes(`${JSON.stringify("/home/dev/project/**")}="read"`), profile);
});

test("a manual ChatGPT implementer can inherit or explicitly configure native tool settings", () => {
  const inherited = chatGpt().planLaunch({
    ...implementer,
    configuration: { ...implementer.configuration, webSearch: undefined, subagents: undefined },
    prompt: "Address the issue.",
  });
  const plan = chatGpt().planLaunch({
    ...implementer,
    configuration: { ...implementer.configuration, webSearch: "live", subagents: "allowed" },
    prompt: "Address the issue.",
  });

  assert.doesNotMatch(inherited.args.join("\n"), /web_search|multi_agent|agents\.enabled|worker-guard/u);
  assert.equal(plan.args.includes('web_search="live"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), false);
  assert.equal(plan.guard, undefined);
});

test("Auto Run overrides permissive ChatGPT worker tool settings", () => {
  const plan = chatGpt().planLaunch({
    ...implementer,
    autoRunRestricted: true,
    configuration: { ...implementer.configuration, webSearch: "live", subagents: "allowed" },
    prompt: "Address the issue.",
    restrictions: { denyWeb: true, denySubagents: true },
  });

  assert.equal(plan.args.includes('web_search="disabled"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), true);
  assert.deepEqual(JSON.parse(plan.guard?.contents ?? "{}"), { denySubagents: true, denyCommands: [] });
});

test("an ordinary ChatGPT launch never mentions browser configuration", () => {
  const plan = chatGpt().planLaunch({ ...implementer, prompt: "Address the issue." });

  assert.equal(plan.chromeRequired, undefined);
  assert.doesNotMatch(plan.args.join("\n"), /chrome/iu);
});

test("a browser-required ChatGPT launch needs its backend declared", async () => {
  const required: string[] = [];
  const platform = chatGpt({ browserProbe: { require: async (agentType) => { required.push(agentType); } } });
  const browserPrompt = "Address the issue.\n\nUse the available tools to take screenshots, test, and debug with a real browser.";
  const plan = platform.planLaunch({ ...implementer, prompt: browserPrompt, chrome: true });

  assert.equal(plan.chromeRequired, true);
  assert.match(plan.args.at(-1) ?? "", /^\$address-this /u);
  await platform.preflight(plan);
  assert.deepEqual(required, ["implementer"]);

  const resumed = platform.planSessionResume({ ...implementer, sessionId: actual, prompt: "Continue", chrome: true });
  assert.equal(resumed.chromeRequired, true);
  assert.equal(resumed.args.at(-1), "Continue");
  // The resume message must not replace the frozen task the reground hook restores.
  assert.equal(resumed.task, undefined);
  assert.equal(resumed.args.includes('web_search="disabled"'), true);
  assert.equal(resumed.args.filter((argument) => argument.startsWith("$address-this")).length, 0);

  const reopened = platform.planSessionResume({ ...implementer, sessionId: actual, chrome: true });
  assert.equal(reopened.promptDelivery, "none");
  assert.ok(reopened.args.at(-1), "reopened args should have content");
  assert.equal(reopened.args.filter((argument) => argument.startsWith("$address-this")).length, 0);
});

test("a Chrome-required ChatGPT launch fails before the terminal when no backend declares Chrome", async () => {
  const platform = chatGpt({ browserProbe: { require: async () => { throw new Error("chrome is not declared"); } } });
  const plan = platform.planLaunch({ ...implementer, prompt: "Address the issue.", chrome: true });

  await assert.rejects(platform.preflight(plan), /chrome is not declared/u);
  assert.throws(
    () => platform.planLaunch({ agentId, sessionId: provisional, agentType: "interactive", shell: "powershell", configuration: { shape: "default" }, prompt: "Hello.", chrome: true }),
    /available only to \[AI\]-chrome auto-run workers/u,
  );
});

test("a ChatGPT reviewer invokes the review skill its disposition selects and inherits the worker boundary", () => {
  const reviewer = {
    agentId: "reviewer-1" as AgentId,
    sessionId: provisional,
    agentType: "reviewer",
    autoRunRestricted: true,
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
    difficulty: "advanced",
    restrictions: { deniedCommands: ["git commit*", "gh pr review*"] },
  } as const;
  const settings = { declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" } as const;

  const afk = chatGpt().planLaunch({
    ...reviewer,
    configuration: { shape: "skill", skillName: "review-this", ...settings },
    prompt: "Review pull request #42.",
  });
  assert.deepEqual(afk.args.slice(-2), ["--", "$review-this Review pull request #42."]);
  assert.equal(afk.writeCapability, "write-capable");
  assert.equal(afk.requiresWriteLease, true);
  assert.equal(afk.args.includes('web_search="disabled"'), true);
  assert.equal(afk.args.includes("features.multi_agent=false"), true);
  assert.deepEqual(JSON.parse(afk.guard?.contents ?? "{}"), { denySubagents: true, denyCommands: ["git commit*", "gh pr review*"] });
  assert.deepEqual(afk.args.slice(afk.args.indexOf("--model"), afk.args.indexOf("--model") + 2), ["--model", "gpt-5.6-sol"]);
  assert.equal(afk.args.includes('model_reasoning_effort="medium"'), true);

  const hitl = chatGpt().planLaunch({
    ...reviewer,
    configuration: { shape: "skill", skillName: "review-this", ...settings },
    prompt: "Review pull request #42.",
    attended: true,
  });
  assert.deepEqual(hitl.args.slice(-2), ["--", "$review-this Review pull request #42."]);
  assert.equal(hitl.requiresWriteLease, true);
});

test("a resumed ChatGPT reviewer keeps its restrictions and does not re-invoke its skill", () => {
  const resumed = chatGpt().planSessionResume({
    agentId: "reviewer-1" as AgentId,
    sessionId: actual,
    agentType: "reviewer",
    autoRunRestricted: true,
    shell: "powershell",
    configuration: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" },
    runtimeDirectory: "C:/aboard/runtime",
    prompt: "Continue",
    difficulty: "expert",
    restrictions: { deniedCommands: ["gh pr merge*"] },
  });

  assert.deepEqual(resumed.args.slice(0, 2), ["resume", actual]);
  assert.deepEqual(resumed.args.slice(-1), ["Continue"]);
  assert.equal(resumed.args.includes('web_search="disabled"'), true);
  assert.equal(resumed.args.includes("agents.enabled=false"), true);
  assert.equal(resumed.args.includes('model_reasoning_effort="high"'), true);
  assert.deepEqual(JSON.parse(resumed.guard?.contents ?? "{}"), { denySubagents: true, denyCommands: ["gh pr merge*"] });
  assert.equal(resumed.task, undefined);
});

test("a ChatGPT reviewer refuses a skill that is not its review mode", () => {
  const request = {
    agentId: "reviewer-1" as AgentId,
    sessionId: provisional,
    agentType: "reviewer",
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
    prompt: "Review pull request #42.",
  } as const;

  assert.throws(
    () => chatGpt().planLaunch({ ...request, configuration: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"] } }),
    /reviewer must launch through \$review-this/u,
  );
  assert.throws(
    () => chatGpt().planLaunch({ ...request, configuration: { shape: "default", declaredCommand: ["codex"] } }),
    /reviewer must launch through \$review-this/u,
  );
  assert.throws(
    () => chatGpt().planLaunch({ ...request, agentType: "implementer", configuration: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"] } }),
    /implementer must launch through \$address-this/u,
  );
});

test("the ChatGPT adapter checks resumability through Codex instead of transcript files", async () => {
  const inspected: unknown[] = [];
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionProbe: {
      inspect: async (sessionId, cwd, command) => {
        inspected.push({ sessionId, cwd, command });
        return { state: "resumable" };
      },
    },
  });

  assert.equal(await platform.isResumable(actual, "C:/work", ["wrapper", "codex"]), true);
  assert.deepEqual(inspected, [{ sessionId: actual, cwd: "C:/work", command: ["wrapper", "codex"] }]);
});
