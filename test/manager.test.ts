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
  const plan = planManagerResume({ agentId, sessionId, shell: "powershell" });
  assert.deepEqual(plan.args, ["--resume", sessionId]);
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

test("start refuses replacement, resume keeps identity, and new replaces it", async () => {
  const records: unknown[] = [];
  const saved: any[] = [];
  let recorded: any = { version: 1, agentId, sessionId, terminalId: "old-terminal", updatedAt: "2026-07-30T09:00:00.000Z" };
  const terminal = (id: string): TerminalSnapshot => ({ terminalId: id as TerminalId, agentId, sessionId, agentType: "manager", name: "aboard: Manager", cwd: "C:\\work", status: "open", createdAt: "2026-07-30T10:00:00.000Z", closedAt: null, exitCode: null });
  const terminals = {
    create: (request: unknown) => { records.push({ kind: "create", request }); return terminal("new-terminal"); },
    resume: (request: unknown) => { records.push({ kind: "resume", request }); return terminal("resumed-terminal"); },
  } as unknown as TerminalController;
  const lifecycle = new ManagerLifecycle({ store: { load: async () => recorded, save: async (value) => { recorded = value; saved.push(value); } }, terminals, workspaceRoot: "C:\\work", shell: "powershell", preset: "delegation-only", disallowedTools: ["Bash(git push*)"], now: () => new Date("2026-07-30T10:00:00.000Z") });
  await assert.rejects(() => lifecycle.start("start"), /Resume Manager or New Manager/);
  await lifecycle.start("resume");
  assert.match((records[0] as any).request.initialCommand, /--resume 4db0ed4c/);
  assert.equal(saved[0].sessionId, sessionId);
  await lifecycle.start("new");
  assert.notEqual(saved[1].sessionId, sessionId);
  assert.match((records[1] as any).request.initialCommand, /--tools 'aboard__\*' Skill AskUserQuestion/);
  assert.match((records[1] as any).request.initialCommand, /--disallowedTools 'Bash\(git push\*\)'/);
});
