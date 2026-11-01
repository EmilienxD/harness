import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSessionRoots, discoverNativeSessions } from "../../src/platform/native-sessions.js";
import { projectSlug } from "../../src/claude/sessions.js";
import { samePath } from "../../src/git/worktree.js";
import { ChatGptSessionProbe } from "../../src/chatgpt/sessions.js";
import { ReopenCoordinator } from "../../src/platform/reopen.js";
import { FleetRegistry } from "../../src/domain/fleet.js";
import type { AgentId, SessionId, IsoTimestamp } from "../../src/domain/contracts.js";

test("native discovery finds outside-Aboard conversations across real Git worktrees and excludes other projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-native-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const piPrevious = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const main = join(root, "main");
    const linked = join(root, "linked");
    await mkdir(main);
    const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
    git("worktree", "add", "-b", "linked", linked);
    const roots = await projectSessionRoots(linked);
    assert(roots.some((path) => samePath(path, main)));
    assert(roots.some((path) => samePath(path, linked)));
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "pi");
    for (const [index, cwd] of [main, linked, join(root, "unrelated")].entries()) {
      const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", projectSlug(cwd));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `session-${index}.jsonl`), JSON.stringify({ type: "user", sessionId: `session-${index}`, cwd, message: { role: "user", content: `Conversation ${index}` } }) + "\n");
    }
    await mkdir(join(process.env.PI_CODING_AGENT_SESSION_DIR, "linked"), { recursive: true });
    await writeFile(join(process.env.PI_CODING_AGENT_SESSION_DIR, "linked", "pi-native.jsonl"), [
      { type: "session", id: "pi-native", cwd: linked },
      { type: "message", id: "user-entry", parentId: null, message: { role: "user", content: "Native Pi conversation" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    // A large transcript must not require reading its middle to render a row.
    const largePath = join(process.env.CLAUDE_CONFIG_DIR, "projects", projectSlug(main), "large.jsonl");
    const large = await open(largePath, "w");
    await large.write(JSON.stringify({ type: "user", sessionId: "large", message: { role: "user", content: "Large conversation" } }) + "\n");
    await large.write(Buffer.from('\n' + JSON.stringify({ type: "custom-title", customTitle: "Tail title" }) + '\n'), 0, undefined, 100 * 1024 * 1024);
    await large.close();
    const logs: string[] = [];
    const options = { cwd: linked, command: async () => ["aboard-missing-provider-for-test"], log: (message: string) => logs.push(message) };
    const sessions = await discoverNativeSessions(options);
    assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ["large", "pi-native", "session-0", "session-1"]);
    assert.equal(sessions.find((session) => session.sessionId === "large")?.title, "Tail title");
    assert(logs.some((line) => line.includes("chatgpt")));
    // Reopening the picker must discover newly-created conversations, without restarting Aboard.
    const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", projectSlug(main));
    await writeFile(join(directory, "new.jsonl"), JSON.stringify({ type: "user", sessionId: "new", message: { role: "user", content: "New conversation" } }) + "\n");
    assert.equal((await discoverNativeSessions(options)).length, 5);
    const plain = join(root, "plain");
    await mkdir(plain);
    assert.deepEqual(await projectSessionRoots(plain), [plain]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    if (piPrevious === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = piPrevious;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery paginates native history using checkout and last-update filters", async () => {
  const probe = new ChatGptSessionProbe({ exchange: async (request) => {
    assert.equal(request.method, "thread/list");
    assert.equal(request.params.cwd, "/project");
    assert.equal(request.params.sortKey, "updated_at");
    assert.equal(request.params.useStateDbOnly, true);
    assert.equal(request.params.limit, 25);
    return request.params.cursor === undefined
      ? { data: [{ id: "first", cwd: "/project", updatedAt: 100, preview: "First" }], nextCursor: "next" }
      : { data: [{ id: "second", cwd: "/project", updatedAt: 200, name: "Second" }], nextCursor: null };
  } });
  assert.deepEqual((await probe.list("/project")).map((session) => session.sessionId), ["first", "second"]);
});

test("Codex falls back to store discovery when its metadata index is empty", async () => {
  const modes: unknown[] = [];
  const probe = new ChatGptSessionProbe({ exchange: async (request) => {
    modes.push(request.params.useStateDbOnly);
    return { data: request.params.useStateDbOnly ? [] : [{ id: "legacy", cwd: "/project", updatedAt: 100 }], nextCursor: null };
  } });
  assert.equal((await probe.list("/project")).length, 1);
  assert.deepEqual(modes, [true, false]);
});

test("session rows publish before discovery finishes and never probe every candidate", async () => {
  let release!: () => void;
  let announced!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const published = new Promise<void>((resolve) => { announced = resolve; });
  let inspections = 0;
  const coordinator = new ReopenCoordinator({
    activity: { entries: () => ({ version: 1, entries: [] }) }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show() {} },
    discover: async (publish) => {
      const sessions = [{ platform: "pi" as const, sessionId: "progressive" as SessionId, cwd: "/project", at: "2026-01-01T00:00:00.000Z" }];
      publish?.(sessions); await waiting; return sessions;
    },
    isResumable: async () => { inspections++; return true; },
    launcher: { reopen: async () => { throw new Error("not invoked"); } },
  });
  const listing = coordinator.list((items) => { if (items.length) announced(); });
  await published;
  assert.equal(inspections, 0);
  release();
  assert.equal((await listing).length, 1);
  assert.equal(inspections, 0);
});

test("native recency updates tracked conversations without losing Aboard identity or restrictions", async () => {
  const coordinator = new ReopenCoordinator({
    activity: { entries: () => ({ version: 1, entries: [{
      kind: "agent", id: "record", agentId: "tracked" as AgentId, type: "address", outcome: "ended",
      description: "Managed worker", at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
      reopen: { platform: "pi", sessionId: "managed" as SessionId, cwd: "/project", autoRunRestricted: true },
    }] }) }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show() {} },
    discover: async () => [
      { platform: "pi", sessionId: "managed" as SessionId, cwd: "/project", at: "2026-01-03T00:00:00.000Z", title: "Updated externally" },
      { platform: "pi", sessionId: "outside" as SessionId, cwd: "/project", at: "2026-01-02T00:00:00.000Z" },
    ],
    isResumable: async () => true,
    launcher: { reopen: async () => { throw new Error("not invoked"); } },
  });
  const options = await coordinator.list();
  assert.equal(options.length, 2);
  const candidate = options[0]!.candidate;
  assert.equal(candidate.agentId, "tracked");
  assert.equal(candidate.type, "address");
  assert.equal(candidate.autoRunRestricted, true);
  assert.equal(candidate.title, "Updated externally");
  assert.equal(candidate.at, "2026-01-03T00:00:00.000Z");
});

test("native sessions allocate a tracking ID only when reopened", async () => {
  let allocations = 0;
  const coordinator = new ReopenCoordinator({
    activity: { entries: () => ({ version: 1, entries: [] }) }, fleet: new FleetRegistry(),
    terminals: { isOpen: () => false, liveTerminalFor: () => undefined, show() {} },
    discover: async () => [{ platform: "pi", cwd: "/project", sessionId: "outside" as SessionId, at: "2026-01-01T00:00:00.000Z", title: "Outside" }],
    allocateAgentId: () => { allocations++; return "42" as AgentId; },
    isResumable: async () => true,
    launcher: { reopen: async (target) => { assert.equal(target.agentId, "42"); assert.equal(target.type, "interactive"); assert.equal(target.sessionId, "outside"); throw new Error("launch observed"); } },
  });
  const options = await coordinator.list();
  assert.equal(allocations, 0);
  assert.equal(options[0]?.candidate.origin, "native");
  await assert.rejects(coordinator.reopen(options[0]!.candidate), /launch observed/u);
  assert.equal(allocations, 1);
});
