import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ChatGptAgentPlatform } from "../../src/chatgpt/platform.js";
import { FileSystemPromptSpillStore } from "../../src/platform/spill.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";

const agentId = "address-1" as AgentId;
const provisional = "6b1e3f7a-2c4d-4a8b-9f10-2c3d4e5f6071" as SessionId;

async function prepared(context: { after(callback: () => Promise<void>): void }): Promise<{ readonly script: string; readonly guard: string }> {
  const root = await mkdtemp(join(tmpdir(), "aboard-guard-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const platform = new ChatGptAgentPlatform({
    lifecycleAssets: {
      settings: join(process.cwd(), "assets", "runtime", "abd-hooks.json"),
      script: join(process.cwd(), "assets", "runtime", "abd_hook.py"),
    },
    commandRunner: async () => ({ code: 0, stdout: "codex-cli 0.153.4", stderr: "" }),
  });
  const plan = platform.planLaunch({
    agentId,
    sessionId: provisional,
    agentType: "address",
    autoRunRestricted: true,
    shell: "powershell",
    configuration: { shape: "skill", skillName: "address-this", declaredCommand: ["codex"] },
    prompt: "Address issue #15.",
    runtimeDirectory: root.replaceAll("\\", "/"),
    restrictions: { denySubagents: true, deniedCommands: ["git commit*", "git push*", "git checkout*", "git -*", "gh pr merge*"] },
  });
  const store = new FileSystemPromptSpillStore(root, root, new Map([["chatgpt", platform.lifecycleAssets]]));
  await store.prepare(plan);
  const guard = join(root, "agents", agentId, "guard.json");
  assert.deepEqual(JSON.parse(await readFile(guard, "utf8")), {
    denySubagents: true,
    denyCommands: ["git commit*", "git push*", "git checkout*", "git -*", "gh pr merge*"],
  });
  return { script: join(root, "scripts", "abd_hook.py"), guard };
}

function decide(script: string, payload: unknown, raw?: string, identity = agentId as string): { readonly status: number | null; readonly decision?: string; readonly reason?: string } {
  const result = spawnSync("uv", ["run", "--no-project", "python", script, "worker-guard"], {
    input: raw ?? JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ABOARD_RUNTIME_ROOT: dirname(dirname(script)), ABOARD_AGENT_ID: identity, ABOARD_AGENT_TYPE: "address" },
  });
  assert.equal(result.stderr, "");
  if (result.stdout.trim().length === 0) return { status: result.status };
  const output = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return { status: result.status, decision: output.hookSpecificOutput.permissionDecision, reason: output.hookSpecificOutput.permissionDecisionReason };
}

function bash(command: string): unknown {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
}

test("the shared ChatGPT guard selects only its process's worker restrictions", async (context) => {
  const { script } = await prepared(context);
  const other = join(dirname(dirname(script)), "agents", "address-2");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "guard.json"), JSON.stringify({ denySubagents: false, denyCommands: ["npm test*"] }));
  assert.equal(decide(script, bash("git push origin HEAD")).decision, "deny");
  assert.deepEqual(decide(script, bash("git push origin HEAD"), undefined, "address-2"), { status: 0 });
  assert.equal(decide(script, bash("npm test"), undefined, "address-2").decision, "deny");
  assert.deepEqual(decide(script, bash("npm test")), { status: 0 });
  for (const identity of ["", "../address-2", "missing-worker"]) {
    assert.equal(decide(script, bash("npm test"), undefined, identity).decision, "deny");
  }
});

test("the ChatGPT worker guard denies Aboard-owned Git and GitHub mutations", async (context) => {
  const { script } = await prepared(context);

  for (const command of [
    "git commit -m 'work'",
    "npm run build && git commit -am wip",
    "git   commit",
    "git -C . commit -m x",
    "gh pr merge 15 --squash",
    "npm test; gh pr merge 15",
  ]) {
    const decision = decide(script, bash(command));
    assert.equal(decision.status, 0, command);
    assert.equal(decision.decision, "deny", command);
    assert.match(decision.reason ?? "", /aboard owns this run's git and GitHub state/u);
    assert.match(decision.reason ?? "", /Follow the completion contract/u);
    assert.doesNotMatch(decision.reason ?? "", /leave your work uncommitted/iu);
  }
});

test("the ChatGPT worker guard denies wrapped Git and GitHub mutations", async (context) => {
  const { script } = await prepared(context);

  for (const command of [
    "env git push origin HEAD",
    "/usr/bin/env MODE=worker git push origin HEAD",
    "env -u GIT_CONFIG_GLOBAL git push origin HEAD",
    "env -S \"git push origin HEAD\"",
    "command git checkout main",
    "sh -c \"gh pr merge 15 --squash\"",
  ]) {
    const decision = decide(script, bash(command));
    assert.equal(decision.status, 0, command);
    assert.equal(decision.decision, "deny", command);
    assert.match(decision.reason ?? "", /aboard owns this run's git and GitHub state/u);
  }
});

test("the ChatGPT worker guard lets ordinary source work and read-only inspection through", async (context) => {
  const { script } = await prepared(context);

  for (const command of [
    "git status --short",
    "git log -5",
    "npm test",
    "gh pr view 15",
    "cat src/main.ts",
    "env git status --short",
    "command git log -5",
    "sh -c \"gh pr view 15\"",
  ]) {
    assert.deepEqual(decide(script, bash(command)), { status: 0 }, command);
  }
  assert.deepEqual(decide(script, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" } }), { status: 0 });
  assert.deepEqual(decide(script, { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } }), { status: 0 });
});

test("the ChatGPT worker guard denies unplanned subagents and a missing restriction list", async (context) => {
  const { script, guard } = await prepared(context);

  for (const tool of ["Agent", "spawn_agent"]) {
    const decision = decide(script, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { prompt: "explore" } });
    assert.equal(decision.decision, "deny", tool);
    assert.match(decision.reason ?? "", /cannot spawn subagents/u);
  }

  // A restriction that cannot read the call it is asked about has to block it.
  for (const unreadable of ["", "{", '["PreToolUse"]']) {
    const decision = decide(script, undefined, unreadable);
    assert.equal(decision.decision, "deny", JSON.stringify(unreadable));
    assert.match(decision.reason ?? "", /cannot read the restriction list/u);
  }

  await rm(guard);
  const decision = decide(script, bash("npm test"));
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason ?? "", /cannot read the restriction list/u);
});
