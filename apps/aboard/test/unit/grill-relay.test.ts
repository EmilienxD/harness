import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { createGrillCloudRelay, grillTarget, workspaceIdentity } from "../../src/grill/cloud-relay.js";
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

/** Writes Harness config files into a disposable workspace and home, as the grill hook would find them. */
function configured(t: { after(fn: () => void): void }, files: { local?: object; shared?: object; user?: object | string }) {
  const base = mkdtempSync(join(tmpdir(), "aboard-grill-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspaceRoot = join(base, "project");
  const home = join(base, "home");
  mkdirSync(join(workspaceRoot, ".harness"), { recursive: true });
  mkdirSync(join(home, ".harness"), { recursive: true });
  const write = (path: string, value: object | string | undefined) => {
    if (value !== undefined) writeFileSync(path, typeof value === "string" ? value : JSON.stringify({ version: 1, grill: value }));
  };
  write(join(workspaceRoot, ".harness", "config.local.json"), files.local);
  write(join(workspaceRoot, ".harness", "config.json"), files.shared);
  write(join(home, ".harness", "config.json"), files.user);
  return { workspaceRoot, home };
}

for (const source of ["local", "user", "environment"] as const) {
  test(`code-only ${source} configuration enables the relay on the production board`, (t) => {
    const { workspaceRoot, home } = configured(t, source === "environment" ? {} : { [source]: { code: "2468" } });
    const env = source === "environment" ? { HARNESS_GRILL_CODE: "2468" } : {};
    assert.deepEqual(grillTarget(workspaceRoot, env, home), { origin: "https://grill-me-in-cloud.vercel.app", code: "2468" });
    const relay = createGrillCloudRelay({
      fleet: new FleetRegistry(), terminals, prompts: new PromptSubmissions(), workspaceRoot, home, environment: env, log: () => undefined,
    });
    assert.ok(relay);
    relay.dispose();
  });
}

test("the production default does not enable a relay without an access code", (t) => {
  const { workspaceRoot, home } = configured(t, {});
  const relay = createGrillCloudRelay({
    fleet: new FleetRegistry(), terminals, prompts: new PromptSubmissions(), workspaceRoot, home, environment: {}, log: () => undefined,
  });
  assert.equal(relay, undefined);
});

test("the relay targets the board the project's config names, not the extension host's environment", (t) => {
  const { workspaceRoot, home } = configured(t, { local: { url: "https://board.example.test", code: "4321" } });
  const localDev = { HARNESS_GRILL_URL: "http://127.0.0.1:4173", HARNESS_GRILL_CODE: "1111" };
  assert.deepEqual(grillTarget(workspaceRoot, localDev, home), { origin: "https://board.example.test", code: "4321" });
});

test("each grill field comes from its first configured source, and the committed config never supplies the code", (t) => {
  const { workspaceRoot, home } = configured(t, {
    shared: { url: "https://shared.example.test", code: "9999" },
    user: { url: "https://user.example.test", code: "2468" },
  });
  assert.deepEqual(grillTarget(workspaceRoot, environment, home), { origin: "https://shared.example.test", code: "2468" });
  assert.deepEqual(grillTarget(workspaceRoot, { ...environment, HARNESS_STATE_DIR: join(home, "elsewhere") }, home), {
    origin: "https://shared.example.test", code: "1234",
  });
});

test("an unreadable Harness config disables the relay with a diagnostic instead of falling back", (t) => {
  const { workspaceRoot, home } = configured(t, { user: "{ not json" });
  const logged: string[] = [];
  const relay = createGrillCloudRelay({
    fleet: new FleetRegistry(), terminals, prompts: new PromptSubmissions(), workspaceRoot, home, environment, log: (message) => logged.push(message),
  });
  assert.equal(relay, undefined);
  assert.equal(logged.length, 1);
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
function harness(t: { after(fn: () => void): void }, confirmationTimeoutMs: number, target: AgentPlatformId = "claude",
  options: { readonly bindingChanges?: boolean; readonly sendFails?: boolean; readonly imagePreparation?: "fail" | "rebind" | "success"; readonly expiryOffsetMs?: number; readonly imageDelayMs?: number } = {}) {
  const claude = "5f0c2d1e-9a8b-4c7d-8e6f-1a2b3c4d5e6f";
  const chatgpt = "codex-thread";
  const pi = "pi-session";
  const fleet = new FleetRegistry();
  for (const session of [liveSession("1", "claude", claude), liveSession("2", "chatgpt", chatgpt), liveSession("3", "pi", pi)]) {
    fleet.register(session, at);
    fleet.transition(session.identity.agentId, { status: "running", startedAt: at }, at);
  }
  let rebound = false;
  const typed: string[] = [];
  const fakeTerminals = {
    liveTerminalForAgent: (agentId: string) => `terminal-${agentId}`,
    get: (terminalId: string) => ({ backend: "terminal", sessionId: options.bindingChanges || rebound
      ? "changed-session" : terminalId === "terminal-1" ? claude : terminalId === "terminal-2" ? chatgpt : pi }),
    sendResumeMessage: async (_terminalId: string, message: string) => {
      if (options.sendFails) throw new Error("Terminal closed");
      typed.push(message);
    },
  } as unknown as TerminalController;
  const syncs: Sync[] = [];
  const targetSession = target === "claude" ? claude : target === "chatgpt" ? chatgpt : pi;
  const payload = "Answers for round 2\n\n- First answer\n- Second answer: é 😀\n";
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const cache = mkdtempSync(join(tmpdir(), "aboard image relay "));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const image = { asset_id: "22222222-2222-4222-8222-222222222222", question_id: "Q1", diagram_id: "flow", sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.length, media_type: "image/png", reference: "https://grill.example.test/api/v1/assets/22222222-2222-4222-8222-222222222222 (authenticated Grill image)", reference_start: payload.length, reference_end: 0 };
  image.reference_end = image.reference_start + image.reference.length;
  const reviewed = options.imagePreparation === "success" ? payload + image.reference : payload;
  const path = join(cache, `${image.sha256}.png`);
  let pending = [{ delivery_id: "d-1", provider: target, session_id: targetSession, prompt: reviewed, expires_at: new Date(Date.now() + (options.expiryOffsetMs ?? 30_000)).toISOString(), ...(options.imagePreparation ? { snapshot_id: "11111111-1111-4111-8111-111111111111", images: [{}] } : {}) }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string; headers?: { Authorization?: string }; redirect?: string }) => {
    if (String(_url).includes("/assets/")) {
      assert.equal(init?.headers?.Authorization, "Bearer 1234");
      assert.equal(init?.redirect, "error");
      return new Response(bytes);
    }
    if (String(_url).includes("/prompt-snapshots/")) {
      if (options.imageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.imageDelayMs));
      await Promise.resolve();
      rebound = options.imagePreparation === "rebind";
      return new Response(JSON.stringify({ snapshot: { id: "11111111-1111-4111-8111-111111111111", prompt: reviewed, images: options.imagePreparation === "success" ? [image] : [] } }), { status: options.imagePreparation === "fail" ? 401 : 200 });
    }
    syncs.push(JSON.parse(init?.body ?? "{}") as Sync);
    const deliveries = pending;
    pending = [];
    return new Response(JSON.stringify({ deliveries }), { status: 200 });
  }) as typeof fetch;
  const prompts = new PromptSubmissions();
  const relay = createGrillCloudRelay({
    fleet, terminals: fakeTerminals, prompts, workspaceRoot: "C:/work/unloopedit", home: "C:/nonexistent-home", log: () => undefined,
    environment, imageCacheDirectory: cache, activeIntervalMs: 10, idleIntervalMs: 10, confirmationTimeoutMs,
  });
  assert.ok(relay);
  t.after(() => { relay.dispose(); prompts.submitted(targetSession as SessionId); globalThis.fetch = realFetch; });
  relay.start();
  const acknowledged = () => syncs.flatMap((sync) => sync.acknowledgements);
  return { claude: claude as SessionId, target: targetSession as SessionId, prompts, typed, syncs, acknowledged, payload, relay, path, bytes };
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
  assert.equal(board.typed.length, 1);
  assert.deepEqual(board.syncs[0]?.sessions, [
    { provider: "claude", session_id: board.claude },
    { provider: "chatgpt", session_id: "codex-thread" },
    { provider: "pi", session_id: "pi-session" },
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

test("an already expired server delivery is rejected before typing", async (t) => {
  const board = harness(t, 60_000, "pi", { expiryOffsetMs: -1 });
  await until(() => board.acknowledged().length === 1);
  assert.equal(board.typed.length, 0);
  assert.equal(board.prompts.submitted(board.target), false);
  assert.match(board.acknowledged()[0]?.failure_message ?? "", /expired before preparation/u);
});

test("image preparation that outlives server expiry cannot type a fallback prompt", async (t) => {
  const board = harness(t, 60_000, "pi", { imagePreparation: "fail", expiryOffsetMs: 50, imageDelayMs: 100 });
  await until(() => board.acknowledged().length === 1);
  assert.equal(board.typed.length, 0);
  assert.equal(board.prompts.submitted(board.target), false);
  assert.match(board.acknowledged()[0]?.failure_message ?? "", /expired during preparation/u);
});

test("confirmation timeout is bounded by the server delivery expiry", async (t) => {
  const board = harness(t, 60_000, "pi", { expiryOffsetMs: 100 });
  await until(() => board.typed.length === 1);
  await until(() => board.acknowledged().length === 1);
  assert.equal(board.acknowledged()[0]?.status, "failed");
  assert.equal(board.prompts.submitted(board.target), false);
});

for (const provider of ["claude", "chatgpt", "pi"] as const) {
  test(`${provider} receives the reviewed payload verbatim`, async (t) => {
    const board = harness(t, 60_000, provider);
    await until(() => board.typed.length === 1);
    assert.equal(board.typed[0], board.payload);
    assert.equal(board.prompts.submitted(board.target), true);
    await until(() => board.acknowledged().length === 1);
    board.relay.dispose();
    assert.equal(board.typed.length, 1);
  });
}

for (const failure of ["bindingChanges", "sendFails"] as const) {
  test(`a ${failure} failure does not submit or leave a pending confirmation`, async (t) => {
    const board = harness(t, 60_000, "chatgpt", { [failure]: true });
    await until(() => board.acknowledged().length === 1);
    assert.equal(board.acknowledged()[0]?.status, "failed");
    assert.equal(board.typed.length, 0);
    assert.equal(board.prompts.submitted(board.target), false);
  });
}

for (const provider of ["claude", "chatgpt", "pi"] as const) {
  test(`${provider} keeps reviewed data on image failure and requires its own confirmation`, async (t) => {
    const board = harness(t, 60_000, provider, { imagePreparation: "fail" });
    await until(() => board.typed.length === 1);
    assert.equal(board.typed[0]!.slice(0, board.payload.length), board.payload);
    assert.deepEqual(board.acknowledged(), []);
    board.prompts.submitted(board.target);
    await until(() => board.acknowledged().length === 1);
    assert.equal(board.acknowledged()[0]!.status, "submitted-to-terminal");
  });
  test(`${provider} refuses a terminal rebound during asynchronous image preparation`, async (t) => {
    const board = harness(t, 100, provider, { imagePreparation: "rebind" });
    await until(() => board.acknowledged().length === 1);
    assert.equal(board.typed.length, 0);
    assert.equal(board.acknowledged()[0]!.status, "failed");
  });
}

for (const provider of ["claude", "chatgpt", "pi"] as const) {
  test(`${provider} downloads authenticated images before typing and exact-session confirmation`, async (t) => {
    const board = harness(t, 60_000, provider, { imagePreparation: "success" });
    await until(() => board.typed.length === 1);
    assert.deepEqual(readFileSync(board.path), board.bytes);
    assert.equal(board.typed[0], board.payload + JSON.stringify(board.path));
    assert.deepEqual(board.acknowledged(), []);
    assert.equal(board.prompts.submitted("unrelated-session" as SessionId), false);
    assert.equal(board.prompts.submitted(board.target), true);
    await until(() => board.acknowledged().length === 1);
    assert.equal(board.acknowledged()[0]!.status, "submitted-to-terminal");
  });
}
