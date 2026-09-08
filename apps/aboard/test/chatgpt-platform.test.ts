import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptAgentPlatform } from "../src/chatgpt/platform.js";
import type { AgentId, SessionId } from "../src/domain/contracts.js";

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

test("the ChatGPT adapter spills a large initial prompt without losing its contents", () => {
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
  assert.equal(plan.spill?.contents, `${prompt.trim()}\n`);
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
  assert.equal(plan.spill?.contents, `${prompt.trim()}\n`);
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

test("a ChatGPT Explore session is a visible top-level Codex session Codex cannot let write", () => {
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
  assert.equal(plan.args.includes('sandbox_mode="read-only"'), true);
  assert.equal(plan.args.includes('approval_policy="never"'), true);
  assert.equal(plan.args.includes("--agent"), false);
  assert.equal(plan.args.at(-2), "--");
  assert.match(plan.spill?.contents ?? "", /^You are a read-only exploration agent\./u);
  assert.match(plan.spill?.contents ?? "", /Report the implementation context for issue #14\./u);
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
    () => platform.planLaunch({ ...request, agentType: "implementer", configuration: { shape: "explore", declaredCommand: ["codex"] }, prompt: "Address the issue." }),
    /ChatGPT does not support implementer sessions yet/u,
  );
});

test("a spilled ChatGPT Explore task keeps its read-only role in the delivered file", () => {
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
  assert.match(plan.spill?.contents ?? "", /^You are a read-only exploration agent\./u);
  assert.match(plan.spill?.contents ?? "", /exploration task/u);
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
