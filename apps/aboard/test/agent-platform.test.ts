import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeAgentPlatform } from "../src/claude/platform.js";
import type { AgentId, SessionId } from "../src/domain/contracts.js";

const agentId = "agent-1" as AgentId;
const sessionId = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;

test("the Claude adapter owns launch planning, capabilities, preflight, and resumability", async () => {
  const probes: readonly string[][] = [];
  const mutableProbes = probes as string[][];
  const platform = new ClaudeAgentPlatform({
    commandRunner: async (program, args) => {
      mutableProbes.push([program, ...args]);
      return { code: 0, stdout: "2.1.199 (Claude Code)\n", stderr: "" };
    },
    resumable: async (candidate, cwd) => candidate === sessionId && cwd === "C:\\work",
  });

  assert.deepEqual(platform.capabilities, {
    sessionIdentity: "client-assigned",
    promptDelivery: ["none", "inline", "spilled"],
    lifecycle: ["start", "stop", "end"],
    models: ["haiku", "sonnet", "opus"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  });

  const plan = platform.planLaunch({
    agentId,
    sessionId,
    agentType: "Explore",
    shell: "powershell",
    configuration: {
      shape: "builtin",
      agentName: "Explore",
      declaredCommand: ["wrapper", "claude"],
      declaredModel: "sonnet",
      declaredEffort: "high",
    },
    prompt: "Map the launch path.",
  });
  assert.equal(plan.platform, "claude");
  assert.deepEqual(plan.command, ["wrapper", "claude"]);
  assert.equal(plan.args.includes("--model"), true);
  assert.equal(plan.args.includes("--effort"), true);

  await platform.preflight(plan.command);
  assert.deepEqual(probes, [["wrapper", "claude", "--version"]]);
  assert.equal(await platform.isResumable(sessionId, "C:\\work"), true);
});
