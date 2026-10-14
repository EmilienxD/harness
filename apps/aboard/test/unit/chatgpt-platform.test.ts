import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";

const agentId = "interactive-1" as AgentId;
const provisional = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;
const actual = "af817a6c-cd41-41e2-a4db-44d3f43cd560" as SessionId;

function hookConfigurations(args: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(args.flatMap((argument, index) =>
    argument === "-c" && args[index + 1]?.startsWith("hooks.")
      ? [args[index + 1]!.split(/=(.*)/su, 2) as [string, string]]
      : []));
}

test("Codex grants every new terminal, fork, and resume access to stable session-scoped lifecycle hooks", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const request = {
    agentId, sessionId: provisional, agentType: "interactive" as const,
    shell: "powershell" as const, configuration: { shape: "default" },
    runtimeDirectory: "C:/aboard/runtime",
  };
  const addedDirectories = (args: readonly string[]) => args.flatMap((argument, index) => argument === "--add-dir" ? [args[index + 1]] : []);
  const first = addedDirectories(platform.planLaunch(request).args);
  assert.deepEqual(first, ["C:/aboard/runtime"]);
  const next = { ...request, agentId: "interactive-2" as AgentId, sessionId: actual };
  assert.deepEqual(addedDirectories(platform.planLaunch(next).args), first);
  assert.deepEqual(addedDirectories(platform.planLaunch({ ...next, forkSessionId: provisional }).args), first);
  assert.deepEqual(addedDirectories(platform.planSessionResume(next).args), first);
  for (const plan of [platform.planLaunch(request), platform.planLaunch({ ...next, forkSessionId: provisional }), platform.planSessionResume(next)]) {
    const hooks = hookConfigurations(plan.args);
    assert.deepEqual(Object.keys(hooks).sort(), ["hooks.SessionEnd", "hooks.SessionStart", "hooks.Stop", "hooks.UserPromptSubmit"]);
    assert.match(hooks["hooks.SessionStart"]!, /matcher="startup\|resume\|fork"/u);
    // Delivery confirmation must never hold up the user's own prompt.
    assert.match(hooks["hooks.UserPromptSubmit"]!, /prompt-submit/u);
    assert.match(hooks["hooks.UserPromptSubmit"]!, /async=true/u);
    assert.ok(hooks["hooks.SessionStart"]!.includes(
      'command="uv run --no-project --no-managed-python \\"C:/aboard/runtime/scripts/abd_hook.py\\" session-start"',
    ));
    assert.doesNotMatch(hooks["hooks.SessionStart"]!, /args=/u);
    const definitions = Object.values(hooks).join("\n");
    assert.doesNotMatch(definitions, /ABOARD_RUNTIME_ROOT|interactive-[12]|6b1e3f7a|af817a6c/u);
  }
});

test("a Codex prompt-submit report becomes the provider-neutral prompt observation", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  assert.deepEqual(platform.normalizeLifecycle("prompt", { agentId, session_id: actual }), { type: "prompt", agentId, sessionId: actual });
});

test("Codex registers worker reporting and guard hooks only for launches that need them", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const common = {
    agentId: "address-1" as AgentId, sessionId: provisional, agentType: "address" as const,
    shell: "powershell" as const, configuration: { shape: "skill" as const, skillName: "address-this" },
    prompt: "Implement.", runtimeDirectory: "C:/aboard/runtime",
  };
  const unguarded = hookConfigurations(platform.planLaunch(common).args);
  assert.deepEqual(Object.keys(unguarded).sort(), [
    "hooks.PostCompact", "hooks.SessionEnd", "hooks.SessionStart", "hooks.Stop", "hooks.StopFailure", "hooks.UserPromptSubmit",
  ]);
  assert.match(unguarded["hooks.SessionStart"]!, /worker-reground/u);
  assert.match(unguarded["hooks.PostCompact"]!, /worker-post-compact/u);
  assert.match(unguarded["hooks.StopFailure"]!, /worker-stop-failure/u);
  assert.equal(unguarded["hooks.PreToolUse"], undefined);

  const guardedPlan = platform.planLaunch({ ...common, autoRunRestricted: true });
  const guarded = hookConfigurations(guardedPlan.args);
  assert.match(guarded["hooks.PreToolUse"]!, /matcher="Bash\|Agent"/u);
  assert.match(guarded["hooks.PreToolUse"]!, /worker-guard/u);
  assert.equal(guardedPlan.providerEnvironment?.ABOARD_GUARD_PATH, "C:/aboard/runtime/agents/address-1/guard.json");
  assert.doesNotMatch(Object.values(guarded).join("\n"), /address-1|ABOARD_GUARD_PATH/u);
});

test("Codex quotes the absolute runtime hook path inside each session-scoped command", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId, sessionId: provisional, agentType: "interactive", shell: "powershell",
    configuration: { shape: "default" }, runtimeDirectory: "C:/Aboard Runtime",
  });
  assert.ok(hookConfigurations(plan.args)["hooks.SessionStart"]!.includes(
    'command="uv run --no-project --no-managed-python \\"C:/Aboard Runtime/scripts/abd_hook.py\\" session-start"',
  ));
});

test("Codex launch and resume preflight require workspace hook consent", async () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    policyProbe: { require: async () => {} },
    approveHooks: async () => false,
  });
  const request = {
    agentId, sessionId: provisional, agentType: "address" as const, autoRunRestricted: true as const,
    shell: "powershell" as const, configuration: { shape: "skill", skillName: "address-this" },
    prompt: "Implement.",
  };
  await assert.rejects(platform.preflight(platform.planLaunch(request)), /hook consent/u);
  await assert.rejects(platform.preflight(platform.planSessionResume(request)), /hook consent/u);
  const interactive = {
    agentId, sessionId: provisional, agentType: "interactive", shell: "powershell",
    configuration: { shape: "default" },
  } as const;
  await assert.rejects(platform.preflight(platform.planLaunch(interactive)), /hook consent/u);
  await assert.rejects(platform.preflight(platform.planSessionResume(interactive)), /hook consent/u);
});

test("workspace hook consent admits manual Codex launches, forks, and resumes", async () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    policyProbe: { require: async () => {} },
    approveHooks: async () => true,
  });
  const request = {
    agentId, sessionId: provisional, agentType: "interactive", shell: "powershell",
    configuration: { shape: "default" },
  } as const;
  for (const plan of [platform.planLaunch(request), platform.planLaunch({ ...request, forkSessionId: actual }), platform.planSessionResume(request)]) {
    assert.ok(plan.args.includes("--dangerously-bypass-hook-trust"));
    await platform.preflight(plan);
  }
});

test("Codex launches and resumes enable lifecycle hooks without native trust review", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  for (const agentType of ["address", "review", "explore"] as const) {
    const request = {
      agentId, sessionId: provisional, agentType, autoRunRestricted: true as const,
      executionMode: "auto-run" as const, shell: "powershell" as const,
      configuration: agentType === "explore" ? { shape: "explore" } : { shape: "skill", skillName: agentType === "address" ? "address-this" : "review-this" },
      prompt: "Work on the issue.", runtimeDirectory: "C:/aboard/runtime",
    };
    assert.ok(platform.planLaunch(request).args.includes("--dangerously-bypass-hook-trust"));
    assert.ok(platform.planLaunch(request).args.includes("--add-dir"));
    if (agentType !== "explore") assert.ok(platform.planSessionResume(request).args.includes("--dangerously-bypass-hook-trust"));
  }
  const manual = platform.planLaunch({
    agentId, sessionId: provisional, agentType: "explore", executionMode: "auto",
    shell: "powershell", configuration: { shape: "explore" }, prompt: "Explore.",
  });
  assert.equal(manual.args.includes("--dangerously-bypass-hook-trust"), true);
});

test("interactive ChatGPT forks preserve history and access to the lifecycle runtime", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId, sessionId: provisional, forkSessionId: actual, agentType: "general",
    executionMode: "interactive", shell: "powershell", configuration: { shape: "default" },
    prompt: "Continue", runtimeDirectory: "C:/aboard/runtime",
  });
  assert.deepEqual(plan.args.slice(plan.args.indexOf("fork"), plan.args.indexOf("fork") + 2), ["fork", actual]);
  assert.ok(plan.args.indexOf("--add-dir") < plan.args.indexOf("fork"));
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--add-dir"), plan.args.indexOf("--add-dir") + 2), ["--add-dir", "C:/aboard/runtime"]);
  assert.match(hookConfigurations(plan.args)["hooks.SessionStart"]!, /startup\|resume\|fork/u);
});

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
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--add-dir"), plan.args.indexOf("--add-dir") + 2), ["--add-dir", "C:/aboard/runtime"]);
  assert.match(hookConfigurations(plan.args)["hooks.SessionStart"]!, /session-start/u);
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
  const reference = /(?:[A-Za-z]:)?[/\\][^\s]+\.md/u.exec(plan.args.at(-1) ?? "")?.[0];
  assert.ok(reference);
  assert.equal((plan.args.at(-1) ?? "").includes("@"), false);
  assert.equal(reference.replaceAll("\\", "/"), plan.spill.relativePath.replaceAll("\\", "/"));
  assert.equal(reference.includes(process.platform === "win32" ? "/" : "\\"), false);
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
    agentType: "explore",
    shell: "powershell",
    configuration: { shape: "explore", declaredCommand: ["wrapper", "run", "codex"] },
    prompt: "Report the implementation context for issue #14.",
    runtimeDirectory: "C:/aboard/runtime",
  });
  await platform.preflight(plan);
  assert.deepEqual(calls, [["wrapper", "run", "codex", "--version"]]);
  assert.deepEqual(required, ["explore"]);
});

test("a ChatGPT explore session preserves its shared prompt while Codex cannot let it write", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
  });

  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "explore",
    shell: "powershell",
    configuration: { shape: "explore", declaredCommand: ["codex"], declaredModel: "gpt-test", declaredEffort: "low" },
    prompt: "Report the implementation context for issue #14.",
    runtimeDirectory: "C:/aboard/runtime",
  });

  assert.equal(plan.agentType, "explore");
  assert.equal(plan.writeCapability, "read-only");
  assert.equal(plan.requiresWriteLease, false);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--sandbox"), plan.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(plan.args.includes('approval_policy="never"'), true);
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.at(-2), "--");
  assert.equal(plan.args.at(-1), "Report the implementation context for issue #14.");
});

test("Auto Run gives ChatGPT exploration a headless exec run and its workers an interactive session", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
    sessionIdFactory: () => provisional,
  });
  const common = {
    agentId,
    sessionId: provisional,
    shell: "powershell",
    executionMode: "auto-run",
    runtimeDirectory: "C:/aboard/runtime",
  } as const;

  const explore = platform.planLaunch({
    ...common,
    agentType: "explore",
    configuration: { shape: "explore", declaredCommand: ["codex"] },
    prompt: "Report the implementation context for issue #14.",
  });
  const address = platform.planLaunch({
    ...common,
    agentType: "address",
    configuration: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"] },
    prompt: "Address issue #14.",
  });

  assert.deepEqual(explore.args.slice(0, 2), ["exec", "--json"]);
  assert.equal(explore.providerEnvironment?.ABOARD_HEADLESS_CHATGPT, "1");
  assert.equal(address.args.includes("exec"), false);
  assert.equal(address.providerEnvironment?.ABOARD_HEADLESS_CHATGPT, undefined);
  assert.equal(address.args.includes("--json"), false);
});

test("a ChatGPT explore session refuses to launch without an exploration task or as another shape", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const request = {
    agentId,
    sessionId: provisional,
    agentType: "explore",
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
  } as const;

  assert.throws(
    () => platform.planLaunch({ ...request, configuration: { shape: "explore", declaredCommand: ["codex"] } }),
    /explore cannot launch without its exploration task/u,
  );
  assert.throws(
    () => platform.planLaunch({ ...request, configuration: { shape: "default", declaredCommand: ["codex"] }, prompt: "Report the context." }),
    /explore launches as a read-only Codex session/u,
  );
  assert.throws(
    () => platform.planLaunch({ ...request, agentType: "review", configuration: { shape: "explore", declaredCommand: ["codex"] }, prompt: "Review the change." }),
    /review must launch through \$review-this/u,
  );
});

test("a large ChatGPT explore task uses spilled delivery", () => {
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: { settings: "hooks.json", script: "hook.py" },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "explore",
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
  assert.deepEqual(plan.args.slice(plan.args.indexOf("resume"), plan.args.indexOf("resume") + 2), ["resume", actual]);
  assert.ok(plan.args.indexOf("--add-dir") < plan.args.indexOf("resume"));
  assert.equal(plan.args.includes("--model"), true);
  assert.equal(plan.args.includes("model_reasoning_effort=\"high\""), true);
  assert.deepEqual(plan.args.slice(-1), ["Continue from the saved state."]);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--add-dir"), plan.args.indexOf("--add-dir") + 2), ["--add-dir", "C:/aboard/runtime"]);
  assert.match(hookConfigurations(plan.args)["hooks.SessionStart"]!, /startup\|resume\|fork/u);
});

const address = {
  agentId: "address-1" as AgentId,
  sessionId: provisional,
  agentType: "address",
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

test("a ChatGPT address invokes the installed address skill with the frozen issue context", () => {
  const plan = chatGpt().planLaunch({
    ...address,
    prompt: "The checked-out branch is for issue #15.",
    difficulty: "basic",
    restrictions: { deniedCommands: ["git commit*", "gh pr create*"], denySubagents: true, denyWeb: true },
  });

  assert.equal(plan.agentType, "address");
  assert.equal(plan.writeCapability, "write-capable");
  assert.equal(plan.requiresWriteLease, true);
  assert.deepEqual(plan.args.slice(-2), ["--", "$address-this The checked-out branch is for issue #15."]);
  assert.equal(plan.chromeRequired, undefined);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--model"), plan.args.indexOf("--model") + 2), ["--model", "gpt-5.6-terra"]);
  assert.equal(plan.args.includes('model_reasoning_effort="high"'), true);
});

test("a ChatGPT address keeps its skill invocation when the frozen contract spills to a file", () => {
  const promptRoot = "C:/Temp/abd-K7M2Q1";
  const plan = chatGpt().planLaunch({
    ...address,
    prompt: "frozen issue contract ".repeat(200),
    promptRoot,
    maxInlinePromptChars: 40,
  });

  assert.equal(plan.promptDelivery, "spilled");
  assert.equal(plan.args.at(-1)?.split(/\s/u)[0], "$address-this");
  assert.equal((plan.args.at(-1) ?? "").includes("@"), false);
  assert.equal(plan.spill?.relativePath, "C:/Temp/abd-K7M2Q1/address-1/task.md");
  assert.equal(plan.task?.relativePath, plan.spill?.relativePath);
});

test("Codex launch, fork, and resume deliver native file references in inline and spilled tasks", () => {
  const platform = chatGpt();
  const request = {
    agentId, sessionId: provisional, agentType: "interactive" as const, shell: "powershell" as const,
    configuration: { shape: "default" }, prompt: '@"src/core.py" @owner', runtimeDirectory: "C:/aboard/runtime",
  };
  for (const maxInlinePromptChars of [4000, 0]) {
    for (const plan of [
      platform.planLaunch({ ...request, maxInlinePromptChars }),
      platform.planLaunch({ ...request, forkSessionId: actual, maxInlinePromptChars }),
      platform.planSessionResume({ ...request, maxInlinePromptChars }),
    ]) {
      const delivered = plan.spill?.contents ?? plan.args.at(-1) ?? "";
      const [path] = [...delivered.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
      assert.equal(path, process.platform === "win32" ? "src\\core.py" : "src/core.py");
      assert.deepEqual(delivered.match(/@\S+/gu), ["@owner"]);
    }
  }
});

test("a ChatGPT address cannot spawn subagents, search the web, or mutate Aboard-owned Git state", () => {
  const plan = chatGpt().planLaunch({
    ...address,
    autoRunRestricted: true,
    prompt: "Address the issue.",
    restrictions: { denySubagents: true, denyWeb: true, deniedCommands: ["git commit*", "gh pr merge*", "git commit*"], protectedPaths: ["C:/project"] },
  });

  assert.equal(plan.args.includes('web_search="disabled"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), true);
  assert.equal(plan.args.includes("agents.enabled=false"), true);
  assert.equal(plan.args.includes("--add-dir"), true);
  assert.equal(plan.providerEnvironment?.ABOARD_GUARD_PATH, "C:/aboard/runtime/agents/address-1/guard.json");
  assert.equal(plan.guard?.relativePath, "C:/aboard/runtime/agents/address-1/guard.json");
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
    ...address,
    prompt: "Address the issue.",
    restrictions: { protectedPaths: ["C:/project"] },
  });

  await assert.rejects(platform.preflight(plan), /Codex 0\.138\.0 or later.*permission profile/u);
});

test("an isolated ChatGPT worker denies writes to the original checkout without denying reads", () => {
  const plan = chatGpt().planLaunch({
    ...address,
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
    ...address,
    prompt: "Address the issue.",
    restrictions: { protectedPaths: ["/home/dev/project/"] },
  });
  const profile = plan.args.find((argument) => argument.startsWith("permissions.aboard-worktree=")) ?? "";

  assert.ok(profile.includes(`${JSON.stringify("/home/dev/project/**")}="read"`), profile);
});

test("a manual ChatGPT address can inherit or explicitly configure native tool settings", () => {
  const inherited = chatGpt().planLaunch({
    ...address,
    configuration: { ...address.configuration, webSearch: undefined, subagents: undefined },
    prompt: "Address the issue.",
  });
  const plan = chatGpt().planLaunch({
    ...address,
    configuration: { ...address.configuration, webSearch: "live", subagents: "allowed" },
    prompt: "Address the issue.",
  });

  assert.doesNotMatch(inherited.args.join("\n"), /web_search|multi_agent|agents\.enabled|worker-guard/u);
  assert.equal(plan.args.includes('web_search="live"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), false);
  assert.equal(plan.guard, undefined);
});

test("Auto Run overrides permissive ChatGPT worker tool settings", () => {
  const plan = chatGpt().planLaunch({
    ...address,
    autoRunRestricted: true,
    configuration: { ...address.configuration, webSearch: "live", subagents: "allowed" },
    prompt: "Address the issue.",
    restrictions: { denyWeb: true, denySubagents: true },
  });

  assert.equal(plan.args.includes('web_search="disabled"'), true);
  assert.equal(plan.args.includes("features.multi_agent=false"), true);
  assert.deepEqual(JSON.parse(plan.guard?.contents ?? "{}"), { denySubagents: true, denyCommands: [] });
});

test("an ordinary ChatGPT launch never mentions browser configuration", () => {
  const plan = chatGpt().planLaunch({ ...address, prompt: "Address the issue." });

  assert.equal(plan.chromeRequired, undefined);
  assert.doesNotMatch(plan.args.join("\n"), /chrome/iu);
});

test("a browser-required ChatGPT launch no longer needs its backend declared", async () => {
  const required: string[] = [];
  const platform = chatGpt({ browserProbe: { require: async (agentType) => { required.push(agentType); } } });
  const browserPrompt = "Address the issue.\n\nUse the available tools to take screenshots, test, and debug with a real browser.";
  const plan = platform.planLaunch({ ...address, prompt: browserPrompt, chrome: true });

  assert.equal(plan.chromeRequired, true);
  assert.match(plan.args.at(-1) ?? "", /^\$address-this /u);
  await platform.preflight(plan);
  // The worker is told to skip the step when it has no browser tool, so a
  // missing Codex backend declaration must not hold up its launch.
  assert.deepEqual(required, []);

  const resumed = platform.planSessionResume({ ...address, sessionId: actual, prompt: "Continue", chrome: true });
  assert.equal(resumed.chromeRequired, true);
  assert.equal(resumed.args.at(-1), "Continue");
  // The resume message must not replace the frozen task the reground hook restores.
  assert.equal(resumed.task, undefined);
  assert.equal(resumed.args.includes('web_search="disabled"'), true);
  assert.equal(resumed.args.filter((argument) => argument.startsWith("$address-this")).length, 0);

  const reopened = platform.planSessionResume({ ...address, sessionId: actual, chrome: true });
  assert.equal(reopened.promptDelivery, "none");
  assert.ok(reopened.args.at(-1), "reopened args should have content");
  assert.equal(reopened.args.filter((argument) => argument.startsWith("$address-this")).length, 0);
});

test("a browser-required ChatGPT review is planned exactly like the address worker", async () => {
  const required: string[] = [];
  const platform = chatGpt({ browserProbe: { require: async (agentType) => { required.push(agentType); } } });
  const plan = platform.planLaunch({
    agentId: "review-1" as AgentId,
    sessionId: provisional,
    agentType: "review",
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
    configuration: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" },
    prompt: "Review pull request #42.",
    chrome: true,
  });

  assert.equal(plan.chromeRequired, true);
  await platform.preflight(plan);
  assert.deepEqual(required, []);
});

test("a Chrome-required ChatGPT launch survives a backend probe that would refuse it", async () => {
  const platform = chatGpt({ browserProbe: { require: async () => { throw new Error("chrome is not declared"); } } });
  const plan = platform.planLaunch({ ...address, prompt: "Address the issue.", chrome: true });

  // Backend enforcement is retained but disabled, so a refusing probe is never
  // consulted and cannot block the worker.
  await platform.preflight(plan);
  assert.throws(
    () => platform.planLaunch({ agentId, sessionId: provisional, agentType: "interactive", shell: "powershell", configuration: { shape: "default" }, prompt: "Hello.", chrome: true }),
    /available only to \[AI\]-chrome auto-run workers/u,
  );
});

test("a ChatGPT review invokes the review skill its disposition selects and inherits the worker boundary", () => {
  const review = {
    agentId: "review-1" as AgentId,
    sessionId: provisional,
    agentType: "review",
    autoRunRestricted: true,
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
    difficulty: "advanced",
    restrictions: { deniedCommands: ["git commit*", "gh pr review*"] },
  } as const;
  const settings = { declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" } as const;

  const afk = chatGpt().planLaunch({
    ...review,
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
    ...review,
    configuration: { shape: "skill", skillName: "review-this", ...settings },
    prompt: "Review pull request #42.",
    attended: true,
  });
  assert.deepEqual(hitl.args.slice(-2), ["--", "$review-this Review pull request #42."]);
  assert.equal(hitl.requiresWriteLease, true);
});

test("a resumed ChatGPT review keeps its restrictions and does not re-invoke its skill", () => {
  const resumed = chatGpt().planSessionResume({
    agentId: "review-1" as AgentId,
    sessionId: actual,
    agentType: "review",
    autoRunRestricted: true,
    shell: "powershell",
    configuration: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"], declaredModel: "by-difficulty", declaredEffort: "by-difficulty", webSearch: "disabled", subagents: "denied" },
    runtimeDirectory: "C:/aboard/runtime",
    prompt: "Continue",
    difficulty: "expert",
    restrictions: { deniedCommands: ["gh pr merge*"] },
  });

  const resumeIndex = resumed.args.indexOf("resume");
  assert.deepEqual(resumed.args.slice(resumeIndex, resumeIndex + 2), ["resume", actual]);
  assert.ok(resumed.args.indexOf("--add-dir") < resumeIndex);
  assert.deepEqual(resumed.args.slice(-1), ["Continue"]);
  assert.equal(resumed.args.includes('web_search="disabled"'), true);
  assert.equal(resumed.args.includes("agents.enabled=false"), true);
  assert.equal(resumed.args.includes('model_reasoning_effort="high"'), true);
  assert.deepEqual(JSON.parse(resumed.guard?.contents ?? "{}"), { denySubagents: true, denyCommands: ["gh pr merge*"] });
  assert.equal(resumed.task, undefined);
});

test("a ChatGPT review refuses a skill that is not its review mode", () => {
  const request = {
    agentId: "review-1" as AgentId,
    sessionId: provisional,
    agentType: "review",
    shell: "powershell",
    runtimeDirectory: "C:/aboard/runtime",
    prompt: "Review pull request #42.",
  } as const;

  assert.throws(
    () => chatGpt().planLaunch({ ...request, configuration: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"] } }),
    /review must launch through \$review-this/u,
  );
  assert.throws(
    () => chatGpt().planLaunch({ ...request, configuration: { shape: "default", declaredCommand: ["codex"] } }),
    /review must launch through \$review-this/u,
  );
  assert.throws(
    () => chatGpt().planLaunch({ ...request, agentType: "address", configuration: { shape: "skill", skillName: "review-this", declaredCommand: ["codex"] } }),
    /address must launch through \$address-this/u,
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
