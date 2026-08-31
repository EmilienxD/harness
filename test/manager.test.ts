import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileManagerStore, ManagerIdentity, ManagerLifecycle } from "../src/claude/manager.js";
import { WorkspaceAgentIdCounter } from "../src/runtime/agent-id-counter.js";
import { planManagerResume, resolveLaunchConfiguration } from "../src/claude/launch.js";
import type { ManagerLaunchDefinition } from "../src/claude/manager.js";
import type { AgentId, IsoTimestamp, SessionId, TerminalId } from "../src/domain/contracts.js";
import type { TerminalController, TerminalSnapshot } from "../src/claude/terminals.js";

const sessionId = "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId;
const agentId = "manager-1" as AgentId;

const MANAGER_TOOLS = ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Skill"];
/** The runtime definition every Manager command line points at. */
const RUNTIME_DIRECTORY = `.aboard/runtime/agents/${agentId}`;
const RUNTIME_AGENT = `aboard-manager-${agentId}`;
const RUNTIME_PATH = `${RUNTIME_DIRECTORY}/.claude/agents/${RUNTIME_AGENT}.md`;
/** The two flags every Manager command line carries, in their shell form. */
const DEFINITION_FLAGS = `--add-dir ${RUNTIME_DIRECTORY} --settings ${RUNTIME_DIRECTORY}/settings.json --agent ${RUNTIME_AGENT}`;
/** The pre-approval list the Manager's command line carries. */
const ABOARD_ALLOW = "mcp__aboard__run_agent,mcp__aboard__todo_create,mcp__aboard__todo_update,mcp__aboard__start_auto_run,mcp__aboard__review_pr";

function managerDefinition(
  extra: { readonly declaredModel?: string; readonly declaredEffort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
): ManagerLaunchDefinition {
  const configuration = resolveLaunchConfiguration({
    agentName: "manager",
    systemPrompt: "You are the Manager.",
    declaredTools: MANAGER_TOOLS,
    ...extra,
  });
  if (configuration.shape !== "agent-defined") throw new Error("unreachable");
  return configuration;
}

/** Records the runtime definition each launch and resume writes before starting. */
function recordingFiles() {
  const written: string[] = [];
  const write = async (file: { relativePath: string }) => { written.push(file.relativePath); return file.relativePath; };
  return { written, store: { write, prepare: async (plan: { agentDefinition?: { relativePath: string } }) => { if (plan.agentDefinition !== undefined) await write(plan.agentDefinition); } } };
}

const definition = async (): Promise<ManagerLaunchDefinition> => managerDefinition();

test("plans a promptless Manager resume with only the recorded UUID", () => {
  const plan = planManagerResume({ agentId, sessionId, shell: "powershell", configuration: managerDefinition() });
  // The recorded UUID plus the definition flags: `--resume` restores the
  // conversation and nothing else, so the persona and tool list travel again.
  assert.deepEqual(plan.args, [
    "--resume",
    sessionId,
    "--add-dir",
    RUNTIME_DIRECTORY,
    "--settings",
    `${RUNTIME_DIRECTORY}/settings.json`,
    "--agent",
    RUNTIME_AGENT,
    "--allowedTools",
    ABOARD_ALLOW,
  ]);
  assert.equal(plan.agentDefinition?.relativePath, RUNTIME_PATH);
  assert.equal(plan.agentDefinition?.contents.includes(`tools: ${MANAGER_TOOLS.join(", ")}`), true);
  assert.equal(plan.promptDelivery, "none");
  assert.equal(plan.requiresWriteLease, false);
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

test("reactivation before the first Manager launch does not consume agent 1", async () => {
  const storage = await mkdtemp(join(tmpdir(), "aboard-manager-identity-"));
  const firstCounter = WorkspaceAgentIdCounter.load(storage);
  let firstMints = 0;
  const firstActivation = new ManagerIdentity(undefined, () => { firstMints += 1; return firstCounter.next(); });

  assert.equal(firstActivation.current(), undefined);
  assert.equal(firstMints, 0);

  // A reload before any Manager launch must see the counter untouched. The
  // next activation therefore gives the first real Manager index 1, not 2.
  const secondCounter = WorkspaceAgentIdCounter.load(storage);
  const secondActivation = new ManagerIdentity(undefined, () => secondCounter.next());
  assert.equal(secondActivation.require(), "1");
  assert.equal(secondActivation.require(), "1");
  assert.equal(secondActivation.current(), "1");
});

test("a recorded Manager identity is reused without minting another index", () => {
  let mints = 0;
  const identity = new ManagerIdentity(agentId, () => { mints += 1; return "2" as AgentId; });
  assert.equal(identity.current(), agentId);
  assert.equal(identity.require(), agentId);
  assert.equal(mints, 0);
});

test("a Manager identity can be restored after scaffold admission opens", () => {
  let mints = 0;
  const identity = new ManagerIdentity(undefined, () => { mints += 1; return "2" as AgentId; });
  identity.restore(agentId);
  assert.equal(identity.require(), agentId);
  assert.equal(mints, 0);
});

test("reset during Manager bundle preparation prevents terminal creation", async () => {
  let admitted = true;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => { release = resolve; });
  let created = false;
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => undefined, save: async () => undefined },
    terminals: { create: () => { created = true; throw new Error("must not create"); } } as unknown as TerminalController,
    workspaceRoot: "C:\\work",
    shell: "powershell",
    admission: () => admitted,
    files: { write: async () => "unused", prepare: async () => preparing },
    definition,
  });

  const launch = lifecycle.start("new");
  admitted = false;
  release();
  await assert.rejects(launch, /runtime reset/);
  assert.equal(created, false);
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
  const files = recordingFiles();
  const lifecycle = new ManagerLifecycle({ store: { load: async () => recorded, save: async (value) => { recorded = value; saved.push(value); } }, terminals, workspaceRoot: "C:\\work", shell: "powershell", files: files.store, definition, disallowedTools: ["Bash(git push*)"], command: () => ["wrapper", "run", "MyProfile", "--"], now: () => new Date("2026-07-30T10:00:00.000Z"), isResumable: async () => true, agentIdFactory: () => "manager-2" as AgentId });
  await lifecycle.start("resume");
  assert.match((records[0] as any).request.initialCommand, /--resume 4db0ed4c/);
  // A wrapper starts the Manager too, resume included, and its arguments stay
  // ahead of every aboard flag.
  assert.match((records[0] as any).request.initialCommand, /^& wrapper run MyProfile -- --resume /);
  assert.equal(saved[0].sessionId, sessionId);
  await lifecycle.start("new");
  assert.notEqual(saved[1].sessionId, sessionId);
  assert.ok((records[1] as any).request.initialCommand.includes(
    "--add-dir .aboard/runtime/agents/manager-2 --settings .aboard/runtime/agents/manager-2/settings.json --agent aboard-manager-manager-2",
  ));
  assert.match((records[1] as any).request.initialCommand, /--disallowedTools 'Bash\(git push\*\)'/);
  // Both the resume and the fresh start write the file `--agent` resolves.
  assert.deepEqual(files.written, [RUNTIME_PATH, ".aboard/runtime/agents/manager-2/.claude/agents/aboard-manager-manager-2.md"]);
});

test("the lifecycle never puts a permission flag on a Manager launch, start or resume", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push(request); return snapshot("terminal"); },
    resume: (request: unknown) => { records.push(request); return snapshot("terminal"); },
  } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({ store: { load: async () => recorded, save: async () => undefined }, terminals, workspaceRoot: "C:\\work", shell: "powershell", files: recordingFiles().store, definition, isResumable: async () => true });
  await lifecycle.start("new");
  assert.doesNotMatch(records[0].initialCommand, /--dangerously-skip-permissions/);
  assert.doesNotMatch(records[0].initialCommand, /--permission-mode/);
  assert.ok(records[0].initialCommand.includes("--allowedTools"));
  assert.match(records[0].initialCommand, /mcp__aboard__run_agent/);
  await lifecycle.start("resume");
  assert.doesNotMatch(records[1].initialCommand, /--dangerously-skip-permissions/);
  assert.doesNotMatch(records[1].initialCommand, /--permission-mode/);
  // Re-passed on resume like every other launch flag.
  assert.ok(records[1].initialCommand.includes("--allowedTools"));
  assert.match(records[1].initialCommand, /mcp__aboard__run_agent/);
  assert.match(records[1].initialCommand, /--resume /);
});

test("the Manager's own model and effort reach the command line on start and on resume", async () => {
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push(request); return snapshot("terminal"); },
    resume: (request: unknown) => { records.push(request); return snapshot("terminal"); },
  } as unknown as TerminalController;
  const options = { store: { load: async () => recorded, save: async () => undefined }, terminals, workspaceRoot: "C:\\work", shell: "powershell" as const, files: recordingFiles().store, isResumable: async () => true, effort: () => "low" as const };
  const lifecycle = new ManagerLifecycle({ ...options, definition: async () => managerDefinition({ declaredModel: "opus", declaredEffort: "medium" }) });
  await lifecycle.start("new");
  assert.match(records[0].initialCommand, /--model opus --effort medium/);
  await lifecycle.start("resume");
  assert.match(records[1].initialCommand, /--resume .* --model opus --effort medium/);

  // A definition that declines to choose leaves aboard.launch.effort deciding.
  const bare = new ManagerLifecycle({ ...options, definition: async () => managerDefinition({ declaredModel: "inherit" }) });
  await bare.start("new");
  assert.doesNotMatch(records[2].initialCommand, /--model/);
  assert.match(records[2].initialCommand, /--effort low/);
});

test("a resume restores the backed-up transcript before asking whether it can be resumed", async () => {
  const order: string[] = [];
  const records: any[] = [];
  const recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const snapshot = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push(request); return snapshot("terminal"); },
    resume: (request: unknown) => { records.push(request); return snapshot("terminal"); },
  } as unknown as TerminalController;
  let restored = false;
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => recorded, save: async () => undefined },
    terminals, workspaceRoot: "C:\\work", shell: "powershell", files: recordingFiles().store, definition,
    restoreTranscript: async (id) => { assert.equal(id, sessionId); order.push("restore"); restored = true; },
    isResumable: async () => { order.push("resumable"); return restored; },
  });
  await lifecycle.start("resume");
  assert.deepEqual(order, ["restore", "resumable"]);
  assert.match(records[0].initialCommand, /--resume 4db0ed4c/);

  // A fresh Manager has no recorded session, so there is nothing to restore.
  order.length = 0;
  await lifecycle.start("new");
  assert.deepEqual(order, []);
});

test("a failed preflight refuses the launch before a terminal exists", async () => {
  const created: unknown[] = [];
  const saved: unknown[] = [];
  const terminals = {
    create: (request: unknown) => { created.push(request); throw new Error("unreachable"); },
  } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => undefined, save: async (value) => { saved.push(value); } },
    terminals, workspaceRoot: "C:\\work", shell: "powershell",
    files: recordingFiles().store, definition,
    command: () => ["wrapper", "run", "MyProfile", "--"],
    isResumable: async () => false,
    preflight: async () => { throw new Error("The configured Claude command cannot be run: wrapper exited with code 1 (ModuleNotFoundError: No module named 'wrapper'). Check aboard.launch.claudeCommand."); },
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
  const saved: any[] = [];
  const lifecycle = new ManagerLifecycle({
    store: { load: async () => recorded, save: async (value) => { saved.push(value); } },
    terminals, workspaceRoot: "C:\\work", shell: "powershell",
    files: recordingFiles().store, definition,
    isResumable: async () => false,
    sessionIdFactory: () => "9f1d6e57-0000-4000-8000-000000000001" as SessionId,
  });
  await lifecycle.start("resume");
  assert.equal(records[0].kind, "create");
  assert.match(records[0].request.initialCommand, /--session-id 9f1d6e57-0000-4000-8000-000000000001/);
  assert.doesNotMatch(records[0].request.initialCommand, new RegExp(sessionId));
  assert.doesNotMatch(records[0].request.initialCommand, /--resume/);
  assert.ok(records[0].request.initialCommand.includes(DEFINITION_FLAGS));
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
    files: recordingFiles().store, definition,
    isResumable: async () => true,
    sessionIdFactory: () => "9f1d6e57-0000-4000-8000-000000000001" as SessionId,
  });
  await lifecycle.start("resume");
  assert.match(records[0].initialCommand, new RegExp(`--resume ${sessionId}`));
  assert.doesNotMatch(records[0].initialCommand, /9f1d6e57/);
});
