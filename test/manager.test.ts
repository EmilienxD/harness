import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileManagerStore, ManagerLifecycle } from "../src/claude/manager.js";
import { planManagerResume } from "../src/claude/launch.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { TerminalController, TerminalSnapshot } from "../src/claude/terminals.js";

const sessionId = "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId;
const agentId = "manager-1" as AgentId;

test("plans a promptless Manager resume with only the recorded UUID", () => {
  const plan = planManagerResume({ agentId, sessionId, shell: "powershell", permissionMode: "default" });
  assert.deepEqual(plan.args, ["--resume", sessionId]);
  assert.equal(plan.promptDelivery, "none");
  assert.equal(plan.requiresWriteLease, false);
});

// The permission mode setting is a launch property, not a worker property: the
// Manager gets it too, on start and on resume alike. bypassPermissions is never
// carried over by --resume, so it has to be re-passed there.
test("the Manager resume carries the configured permission mode", () => {
  const plan = planManagerResume({ agentId, sessionId, shell: "powershell", permissionMode: "bypass" });
  assert.deepEqual(plan.args, ["--resume", sessionId, "--dangerously-skip-permissions"]);
});

test("manager metadata persists and corrupt metadata recovers as missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-manager-"));
  const store = new FileManagerStore(root);
  const value = { version: 1 as const, agentId, sessionId, terminalId: "terminal-1" as TerminalId, updatedAt: "2026-07-30T10:00:00.000Z" as IsoTimestamp };
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  const path = join(root, ".aboard", "runtime", "manager.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
  await writeFile(path, "not json", "utf8");
  assert.equal(await store.load(), undefined);
});

test("resume keeps the recorded identity and new replaces the session", async () => {
  const records: unknown[] = [];
  const saved: any[] = [];
  let recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const terminal = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push({ kind: "create", request }); return terminal("new-terminal"); },
    resume: (request: unknown) => { records.push({ kind: "resume", request }); return terminal("resumed-terminal"); },
  } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({ store: { load: async () => recorded, save: async (value) => { recorded = value; saved.push(value); } }, terminals, workspaceRoot: "C:\\work", shell: "powershell", disallowedTools: ["Bash(git push*)"], command: () => ["clauder", "run", "kiro", "--"], now: () => new Date("2026-07-30T10:00:00.000Z"), isResumable: async () => true });
  await lifecycle.start("resume");
  assert.match((records[0] as any).request.initialCommand, /--resume 4db0ed4c/);
  // A wrapper starts the Manager too, resume included, and its arguments stay
  // ahead of every aboard flag.
  assert.match((records[0] as any).request.initialCommand, /^& clauder run kiro -- --resume /);
  assert.equal(saved[0].sessionId, sessionId);
  await lifecycle.start("new");
  assert.notEqual(saved[1].sessionId, sessionId);
  // The Manager's tool set lives in manager.md; the command line names the
  // definition and carries no --tools.
  assert.match((records[1] as any).request.initialCommand, /--agent manager/);
  assert.doesNotMatch((records[1] as any).request.initialCommand, /--tools/);
  assert.match((records[1] as any).request.initialCommand, /--disallowedTools 'Bash\(git push\*\)'/);
});

test("the lifecycle applies the configured permission mode to start and resume", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push(request); return snapshot("terminal"); },
    resume: (request: unknown) => { records.push(request); return snapshot("terminal"); },
  } as unknown as TerminalController;
  // Read through a callback, so toggling the setting takes effect on the next
  // launch rather than at the next window reload.
  let mode: "bypass" | "default" = "bypass";
  const lifecycle = new ManagerLifecycle({ store: { load: async () => recorded, save: async () => undefined }, terminals, workspaceRoot: "C:\\work", shell: "powershell", permissionMode: () => mode, isResumable: async () => true });
  await lifecycle.start("new");
  assert.match(records[0].initialCommand, /--dangerously-skip-permissions/);
  await lifecycle.start("resume");
  assert.match(records[1].initialCommand, /--resume .* --dangerously-skip-permissions/);
  mode = "default";
  await lifecycle.start("new");
  assert.doesNotMatch(records[2].initialCommand, /--dangerously-skip-permissions/);
});

test("the Manager's own model and effort reach the command line on start and on resume", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push(request); return snapshot("terminal"); },
    resume: (request: unknown) => { records.push(request); return snapshot("terminal"); },
  } as unknown as TerminalController;
  // `--agent manager` honors neither field in manager.md and `--resume` reads no
  // definition at all, so both have to travel as flags or the Manager silently
  // runs at the user's global model and effort.
  const options = { store: { load: async () => recorded, save: async () => undefined }, terminals, workspaceRoot: "C:\\work", shell: "powershell" as const, isResumable: async () => true, effort: () => "low" as const };
  const lifecycle = new ManagerLifecycle({ ...options, definition: async () => ({ model: "opus", effort: "medium" as const }) });
  await lifecycle.start("new");
  assert.match(records[0].initialCommand, /--agent manager --model opus --effort medium/);
  await lifecycle.start("resume");
  assert.match(records[1].initialCommand, /--resume .* --model opus --effort medium/);

  // An unreadable or `inherit` definition leaves aboard.launch.effort deciding.
  const bare = new ManagerLifecycle({ ...options, definition: async () => undefined });
  await bare.start("new");
  assert.doesNotMatch(records[2].initialCommand, /--model/);
  assert.match(records[2].initialCommand, /--effort low/);
});

test("a failed preflight refuses the launch before a terminal exists", async () => {
  // The launch command is typed into a shell aboard cannot read the exit
  // status of, so a command it already knows cannot run must never open a
  // terminal — that terminal would only ever show a shell error while the
  // fleet believed a Manager was starting.
  const created: unknown[] = [];
  const saved: unknown[] = [];
  const terminals = {
    create: (request: unknown) => { created.push(request); throw new Error("unreachable"); },
  } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => undefined, save: async (value) => { saved.push(value); } },
    terminals, workspaceRoot: "C:\\work", shell: "powershell",
    command: () => ["clauder", "run", "kiro", "--"],
    isResumable: async () => false,
    preflight: async () => { throw new Error("The configured Claude command cannot be run: clauder exited with code 1 (ModuleNotFoundError: No module named 'clauder'). Check aboard.launch.claudeCommand."); },
  });
  await assert.rejects(() => lifecycle.start("new"), /cannot be run/);
  assert.equal(created.length, 0);
  assert.equal(saved.length, 0);
});

test("an unresumable recorded session starts afresh under a new id, keeping the agent", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push({ kind: "create", request }); return snapshot("fresh-terminal"); },
    resume: (request: unknown) => { records.push({ kind: "resume", request }); return snapshot("resumed-terminal"); },
  } as unknown as TerminalController;
  // The recorded session holds no conversation, so --resume refuses it. Reusing
  // the id would be refused too — Claude rejects --session-id for any id that
  // already has a transcript, and this one does; that is why --resume failed.
  const saved: any[] = [];
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => recorded, save: async (value) => { saved.push(value); } },
    terminals, workspaceRoot: "C:\\work", shell: "powershell",
    isResumable: async () => false,
    sessionIdFactory: () => "9f1d6e57-0000-4000-8000-000000000001" as SessionId,
  });
  await lifecycle.start("resume");
  assert.equal(records[0].kind, "create");
  assert.match(records[0].request.initialCommand, /--session-id 9f1d6e57-0000-4000-8000-000000000001/);
  assert.doesNotMatch(records[0].request.initialCommand, new RegExp(sessionId));
  assert.doesNotMatch(records[0].request.initialCommand, /--resume/);
  assert.match(records[0].request.initialCommand, /--agent manager/);
  // Manager identity is the agent id, which survives; the new conversation id
  // is recorded so the next resume targets it.
  assert.equal(records[0].request.agentId, agentId);
  assert.equal(saved[0].agentId, agentId);
  assert.equal(saved[0].sessionId, "9f1d6e57-0000-4000-8000-000000000001");
});

test("a resumable recorded session keeps its id and resumes", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = { create: (request: any) => { records.push(request); return snapshot("fresh-terminal"); } } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => recorded, save: async () => undefined },
    terminals, workspaceRoot: "C:\\work", shell: "powershell",
    isResumable: async () => true,
    sessionIdFactory: () => "9f1d6e57-0000-4000-8000-000000000001" as SessionId,
  });
  await lifecycle.start("resume");
  assert.match(records[0].initialCommand, new RegExp(`--resume ${sessionId}`));
  assert.doesNotMatch(records[0].initialCommand, /9f1d6e57/);
});
