import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchFile } from "../../src/platform/launch-configuration.js";
import { PiAgentPlatform } from "../../src/pi/platform.js";
import type { AgentId, SessionId } from "../../src/domain/contracts.js";
import { inspectPiSession, piSessionDirectory } from "../../src/pi/sessions.js";

test("Pi profiles accept native thinking and shared effort aliases", () => {
  const platform = new PiAgentPlatform({ lifecycleAssets: { settings: "unused", script: "unused" }, commandRunner: async () => ({ code: 0, stdout: "1.2.0", stderr: "" }) });
  for (const [effort, native] of [["off", "off"], ["none", "off"], ["ultra", "max"], ["max", "max"]]) {
    const config = parseLaunchFile(JSON.stringify({ version: 1, providers: { pi: { interactive: { effort } } } })).value;
    const plan = platform.planLaunch({ agentId: "thinking" as AgentId, sessionId: platform.createSession().sessionId, shell: "powershell", agentType: "interactive", configuration: config.configurationFor("pi", "interactive").settings });
    assert.equal(plan.args[plan.args.indexOf("--thinking") + 1], native);
  }
});

test("Pi resolves global relative session storage from the launched project", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-pi-settings-"));
  const priorAgent = process.env.PI_CODING_AGENT_DIR;
  const priorSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  const agent = join(root, "agent");
  const project = join(root, "project");
  try {
    await mkdir(agent); await mkdir(project);
    await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: "saved-sessions" }));
    process.env.PI_CODING_AGENT_DIR = agent;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    assert.equal(await piSessionDirectory(project), join(project, "saved-sessions"));
    process.env.PI_CODING_AGENT_SESSION_DIR = "environment-sessions";
    assert.equal(await piSessionDirectory(project), join(project, "environment-sessions"));
    assert.equal(await piSessionDirectory(project, ["pi", "--session-dir", "command-sessions"]), join(project, "command-sessions"));
  } finally {
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
    if (priorSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = priorSessions;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi preserves interactive resources and isolates exploration through native launch controls", async () => {
  const config = parseLaunchFile(JSON.stringify({ version: 1, autoRun: { provider: "pi" } })).value;
  const platform = new PiAgentPlatform({ lifecycleAssets: { settings: "unused", script: "abd_pi.ts" }, commandRunner: async () => ({ code: 0, stdout: "1.2.0", stderr: "" }) });
  const identity = platform.createSession();
  assert.equal(identity.binding, "provisional");
  const common = { agentId: "agent-1" as AgentId, sessionId: identity.sessionId, shell: "powershell" as const };
  const interactive = platform.planLaunch({ ...common, agentType: "interactive", configuration: config.configurationFor("pi", "interactive").settings });
  assert.equal(interactive.args.includes("--no-extensions"), false);
  assert.equal(interactive.args.includes("--mode"), false);
  assert.equal(interactive.args.includes("--session-id"), false);
  assert.equal(interactive.providerEnvironment?.ABOARD_PI_ASSIGN_SESSION, "1");
  const explore = platform.planLaunch({ ...common, agentType: "explore", executionMode: "auto", configuration: config.configurationFor("pi", "explore").settings, prompt: "Inspect source" });
  assert.equal(explore.writeCapability, "read-only");
  assert.equal(explore.args.includes("--no-extensions"), true);
  assert.equal(explore.args.includes("--no-mcp"), true);
  assert.equal(explore.args.includes("json"), true);
  assert.equal(explore.args[explore.args.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.doesNotThrow(() => platform.requireEnforceableRestrictions({ protectedPaths: ["C:/source"] }));
  const worktreeRequest = { ...common, cwd: "C:/run-checkout", agentType: "address" as const,
    configuration: config.configurationFor("pi", "address").settings,
    restrictions: { protectedPaths: ["C:/source"], deniedCommands: ["git push*"] }, prompt: "Implement the issue" };
  for (const plan of [platform.planLaunch(worktreeRequest), platform.planSessionResume(worktreeRequest)]) {
    assert.equal(plan.providerEnvironment?.ABOARD_PI_CWD, "C:/run-checkout");
    assert.equal(plan.requiresWriteLease, true);
    assert.deepEqual(JSON.parse(plan.guard!.contents).denyCommands, ["git push*"]);
    assert.ok(plan.providerEnvironment?.ABOARD_WORKTREE_GUIDANCE);
  }
  const fork = platform.planLaunch({ ...common, sessionId: platform.createSession().sessionId, forkSessionId: identity.sessionId, agentType: "interactive", configuration: config.configurationFor("pi", "interactive").settings });
  assert.equal(fork.args[fork.args.indexOf("--fork") + 1], identity.sessionId);
  assert.equal(fork.args[fork.args.indexOf("--session-id") + 1], fork.sessionId);
  assert.equal(platform.bindSession(identity, "native" as SessionId), "native");
  assert.equal(platform.bindSession({ ...identity, binding: "bound" }, "stale" as SessionId), undefined);
  await platform.preflight(interactive);
});

test("Pi resume accepts only a saved conversation with matching project and intact active ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-pi-session-"));
  const prior = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  const platform = new PiAgentPlatform({ lifecycleAssets: { settings: "unused", script: "unused" }, commandRunner: async () => ({ code: 0, stdout: "1.2.0", stderr: "" }) });
  const sessionId = platform.createSession().sessionId;
  const path = join(root, `fixture_${sessionId}.jsonl`);
  const rows = [{ type: "session", version: 3, id: sessionId, cwd: root }, { type: "message", id: "user", parentId: null, message: { role: "user", content: "Inspect source" } }, { type: "session_info", id: "title", parentId: "user", name: "Saved conversation" }];
  try {
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    assert.equal(await platform.isResumable(sessionId, root), true);
    assert.equal((await inspectPiSession(sessionId, root))?.title, "Saved conversation");
    await writeFile(path, rows.slice(0, 2).map((row) => JSON.stringify(row)).join("\n"));
    assert.equal((await inspectPiSession(sessionId, root))?.title, "Inspect source");
    assert.equal(await platform.isResumable(sessionId, join(root, "different")), false);
    rows[2]!.parentId = "missing";
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    assert.equal(await platform.isResumable(sessionId, root), false);
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});
