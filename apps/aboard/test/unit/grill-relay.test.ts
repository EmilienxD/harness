import assert from "node:assert/strict";
import { sep } from "node:path";
import test from "node:test";

import { createGrillCloudRelay, workspaceIdentity } from "../../src/grill/cloud-relay.js";
import type { AgentId, AgentPlatformId, AgentSession, IsoTimestamp, SessionId, TerminalId } from "../../src/domain/contracts.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import { PromptSubmissions } from "../../src/platform/prompt-submissions.js";
import type { TerminalController } from "../../src/platform/terminals.js";

const terminals = { liveTerminalForAgent: () => undefined } as unknown as TerminalController;
const environment = { HARNESS_GRILL_URL: "https://grill.example.test", HARNESS_GRILL_CODE: "1234" };
const at = "2026-09-22T10:00:00.000Z" as IsoTimestamp;

test("a workspace inside the home directory is named without publishing the home path", () => {
  const home = ["", "home", "dana"].join(sep) || sep;
  const root = [home, "code", "unloopedit"].join(sep);
  assert.deepEqual(workspaceIdentity(root, home), { name: "unloopedit", path: `~${sep}code${sep}unloopedit` });
  assert.equal(workspaceIdentity(home, home).path, "~");
});

test("a workspace outside the home directory keeps its absolute path", () => {
  const home = ["", "home", "dana"].join(sep) || sep;
  const root = ["", "srv", "checkouts", "unloopedit"].join(sep);
  assert.deepEqual(workspaceIdentity(root, home), { name: "unloopedit", path: root });
});

test("two windows on one workspace share a project scope but not an instance", () => {
  const home = ["", "home", "dana"].join(sep) || sep;
  const options = { fleet: new FleetRegistry(), terminals, prompts: new PromptSubmissions(), home, log: () => undefined, environment };
  const root = [home, "code", "unloopedit"].join(sep);
  const first = createGrillCloudRelay({ ...options, workspaceRoot: root });
  const second = createGrillCloudRelay({ ...options, workspaceRoot: root });
  const other = createGrillCloudRelay({ ...options, workspaceRoot: [home, "code", "other"].join(sep) });
  assert.ok(first && second && other);
  const scope = (relay: { instanceId: string }) => relay.instanceId.split(":")[0];
  assert.equal(scope(first), scope(second));
  assert.notEqual(scope(first), scope(other));
  assert.notEqual(first.instanceId, second.instanceId);
  first.dispose();
  second.dispose();
  other.dispose();
});

test("prompts typed into one session confirm in order, and an unconfirmed one times out", async () => {
  const prompts = new PromptSubmissions();
  const session = "0b7c4a52-1a51-4c1d-8f3e-6d0e1f2a3b4c" as SessionId;
  const first = prompts.expect(session, 60_000);
  const second = prompts.expect(session, 60_000);
  assert.equal(prompts.submitted(session), true);
  assert.equal(await first.confirmed, true);
  second.cancel();
  assert.equal(await second.confirmed, false);
  assert.equal(prompts.submitted(session), false);
  assert.equal(await prompts.expect(session, 5).confirmed, false);
});

type Sync = { readonly sessions: readonly Record<string, unknown>[]; readonly acknowledgements: readonly { delivery_id: string; status: string; failure_message?: string }[] };

function liveSession(agentId: string, platform: AgentPlatformId, sessionId: string): AgentSession {
  return {
    platform, identity: { agentId: agentId as AgentId, type: "interactive" }, sessionId: sessionId as SessionId, sessionBinding: "bound",
    terminal: { terminalId: `terminal-${agentId}` as TerminalId, name: agentId }, lifecycle: { status: "starting", startedAt: at },
    resultDelivery: { mode: "none" }, attended: true,
    telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  };
}

/** Drives a relay against a scripted board so a delivery's acknowledgement can be observed. */
function harness(t: { after(fn: () => void): void }, confirmationTimeoutMs: number, target: AgentPlatformId = "claude") {
  const claude = "5f0c2d1e-9a8b-4c7d-8e6f-1a2b3c4d5e6f";
  const chatgpt = "codex-thread";
  const fleet = new FleetRegistry();
  for (const session of [liveSession("1", "claude", claude), liveSession("2", "chatgpt", chatgpt)]) {
    fleet.register(session, at);
    fleet.transition(session.identity.agentId, { status: "running", startedAt: at }, at);
  }
  const typed: string[] = [];
  const fakeTerminals = {
    liveTerminalForAgent: (agentId: string) => `terminal-${agentId}`,
    get: (terminalId: string) => ({ backend: "terminal", sessionId: terminalId === "terminal-1" ? claude : chatgpt }),
    sendResumeMessage: async (_terminalId: string, message: string) => { typed.push(message); },
  } as unknown as TerminalController;
  const syncs: Sync[] = [];
  const targetSession = target === "claude" ? claude : chatgpt;
  let pending = [{ delivery_id: "d-1", provider: target, session_id: targetSession, prompt: "Answers for round 2" }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    syncs.push(JSON.parse(init?.body ?? "{}") as Sync);
    const deliveries = pending;
    pending = [];
    return new Response(JSON.stringify({ deliveries }), { status: 200 });
  }) as typeof fetch;
  const prompts = new PromptSubmissions();
  const relay = createGrillCloudRelay({
    fleet, terminals: fakeTerminals, prompts, workspaceRoot: "C:/work/unloopedit", log: () => undefined,
    environment, activeIntervalMs: 10, idleIntervalMs: 10, confirmationTimeoutMs,
  });
  assert.ok(relay);
  t.after(() => { relay.dispose(); globalThis.fetch = realFetch; });
  relay.start();
  const acknowledged = () => syncs.flatMap((sync) => sync.acknowledgements);
  return { claude: claude as SessionId, target: targetSession as SessionId, prompts, typed, syncs, acknowledged };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a delivery is acknowledged only after Claude confirms the typed prompt", async (t) => {
  const board = harness(t, 60_000);
  await until(() => board.typed.length === 1);
  // Heartbeats keep flowing while the relay waits, and none of them may report success early.
  const heartbeats = board.syncs.length;
  await until(() => board.syncs.length >= heartbeats + 3);
  assert.deepEqual(board.acknowledged(), []);

  assert.equal(board.prompts.submitted(board.claude), true);
  await until(() => board.acknowledged().length === 1);
  assert.deepEqual(board.acknowledged(), [{ delivery_id: "d-1", status: "submitted-to-terminal" }]);
  assert.deepEqual(board.typed, ["Answers for round 2"]);
  assert.deepEqual(board.syncs[0]?.sessions, [
    { provider: "claude", session_id: board.claude },
    { provider: "chatgpt", session_id: "codex-thread" },
  ]);
});

test("a ChatGPT delivery is acknowledged once its own session confirms, not another's", async (t) => {
  const board = harness(t, 60_000, "chatgpt");
  await until(() => board.typed.length === 1);
  assert.equal(board.prompts.submitted(board.claude), false);
  assert.equal(board.prompts.submitted(board.target), true);
  await until(() => board.acknowledged().length === 1);
  assert.deepEqual(board.acknowledged(), [{ delivery_id: "d-1", status: "submitted-to-terminal" }]);
});

test("a typed prompt Claude never confirms is reported as failed", async (t) => {
  const board = harness(t, 20);
  await until(() => board.acknowledged().length === 1);
  assert.equal(board.acknowledged()[0]?.status, "failed");
  assert.match(board.acknowledged()[0]?.failure_message ?? "", /did not confirm/u);
});
