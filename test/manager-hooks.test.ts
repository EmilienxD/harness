import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { EOL } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ManagerBriefings, ManagerPromptService, ManagerStopService, RoadmapReminderService, createManagerHookRoutes, HOOK_OUTPUT_LIMIT, ROADMAP_INLINE_LIMIT, ROADMAP_MARKER, type BriefingSources, type RoadmapBriefing } from "../src/bridge/manager-hooks.js";
import { parseRoadmap } from "../src/domain/roadmap.js";
import type { AuthenticatedBridgeRequest } from "../src/bridge/protocol.js";
import type { AgentId, AgentSession, IsoTimestamp, SessionId, TerminalId, WorkerResult } from "../src/domain/contracts.js";
import { FleetRegistry } from "../src/domain/fleet.js";
import { WriteLease } from "../src/domain/lease.js";

const at = (value: string) => value as IsoTimestamp;
const agent = (value: string) => value as AgentId;
const session = (value: string) => value as SessionId;
const terminal = (value: string) => value as TerminalId;
const timestamp = at("2026-07-30T12:00:00.000Z");

function manager(fleet: FleetRegistry): AgentId {
  const id = agent("manager-1");
  fleet.register({
    identity: { agentId: id, type: "manager" }, sessionId: session("140b5c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminal("manager-terminal"), name: "manager" }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, timestamp);
  fleet.transition(id, { status: "running", startedAt: timestamp }, timestamp);
  return id;
}

function worker(fleet: FleetRegistry, managerAgentId: AgentId, status: AgentSession["lifecycle"]["status"] = "running"): AgentId {
  const id = agent(`worker-${fleet.list().length}`);
  const lifecycle: AgentSession["lifecycle"] = status === "running"
    ? { status, startedAt: timestamp }
    : { status: "completed", startedAt: timestamp, finishedAt: timestamp, exitCode: 0, lastAssistantMessage: "done" };
  fleet.register({ identity: { agentId: id, type: "implementer" }, sessionId: session(`4db0ed4c-5d9e-4ab5-a493-2b8575ab19e${fleet.list().length}`),
    terminal: { terminalId: terminal(`${id}-terminal`), name: id }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "mailbox", managerAgentId }, telemetry: { totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3, compactionCount: 0 }, issueNumber: 12 }, timestamp);
  fleet.transition(id, lifecycle, timestamp);
  return id;
}

/** Long enough that the roadmap section alone exceeds its inline allowance. */
const LONG_ROADMAP = Array.from({ length: 400 }, (_, index) => `- [ ] Roadmap task number ${index}`).join("\n");

const EMPTY_GITHUB = { issues: [], openPullRequests: [], unreviewedMergeCount: 0 } as const;

/** A roadmap briefing built from a real body, so ids are the ones the CLI derives. */
function roadmapOf(body: string, overrides: Partial<RoadmapBriefing> = {}): RoadmapBriefing {
  const parsed = parseRoadmap(body);
  return { number: 9, tasks: parsed.tasks, duplicateSubjects: parsed.duplicateSubjects, carrierCount: 1, nearBound: false, ...overrides };
}

function sources(overrides: Partial<BriefingSources> = {}): BriefingSources {
  return {
    repository: async () => ({ name: "aboard", defaultBranch: "main", checks: ["npm run check"] }),
    git: async () => ({ branch: "main", head: "abc123", dirty: false }),
    github: async () => EMPTY_GITHUB,
    roadmap: async () => undefined,
    autoRun: () => undefined,
    ...overrides,
  };
}

test("the state block carries the facts a Manager would otherwise fetch", async () => {
  const fleet = new FleetRegistry(); manager(fleet);
  const briefings = new ManagerBriefings(sources({
    github: async () => ({
      issues: [
        { number: 12, title: "Rework the fleet tree", disposition: "afk", blockedBy: [] },
        { number: 14, title: "Rotate bridge tokens", disposition: "hitl", blockedBy: [12] },
      ],
      openPullRequests: [{ number: 21, title: "Fix lease recovery", reviewState: "no review yet" }],
      unreviewedMergeCount: 2,
    }),
    roadmap: async () => roadmapOf("- [ ] Ship the bridge\n- [x] Rotate the tokens"),
    autoRun: () => ({ specNumber: 4, specTitle: "Bridge hardening", phase: "await-approval", currentIssue: 14, completedCount: 1, waitingOnPullRequest: 21 }),
  }), fleet, new WriteLease());
  const rendered = await briefings.render(new AbortController().signal);

  assert.match(rendered, /^<aboard-state>/);
  assert.match(rendered, /<\/aboard-state>$/);
  // Titles, not bare numbers: a number alone costs a `gh` round trip per issue.
  assert.match(rendered, /#12 Rework the fleet tree \(afk\)/);
  assert.match(rendered, /#14 Rotate bridge tokens \(hitl\) - waits on #12/);
  assert.match(rendered, /#21 Fix lease recovery \(no review yet\)/);
  assert.match(rendered, /2 pull request\(s\) merged without review/);
  // The roadmap itself, with its ids, so no tool call is needed to read or
  // address it — and the completed history included, because session start is
  // one of the two moments the Manager's context is empty.
  assert.match(rendered, /## Roadmap\n<aboard-roadmap>\nIssue #9/);
  assert.match(rendered, /^- \[ \] \[[0-9a-f]{4}\] Ship the bridge$/m);
  assert.match(rendered, /^- \[x\] \[[0-9a-f]{4}\] Rotate the tokens$/m);
  assert.match(rendered, /<\/aboard-roadmap>/);
  assert.match(rendered, /PR #21 is hitl and waiting/);
  assert.match(rendered, /default branch main \| verify with npm run check/);
});

test("hook output stays ASCII-only so the Claude TUI renders it cleanly", async () => {
  const ascii = /^[\x20-\x7E\n]*$/;
  const fleet = new FleetRegistry(); const managerId = manager(fleet); const workerId = worker(fleet, managerId);
  fleet.register({
    identity: { agentId: agent("general-purpose-1"), type: "general-purpose" }, sessionId: session("bdb05c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminal("general-purpose-terminal"), name: "general-purpose" }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, timestamp);
  fleet.transition(agent("general-purpose-1"), { status: "running", startedAt: timestamp }, timestamp);
  const briefings = new ManagerBriefings(sources({
    github: async () => ({
      issues: [
        { number: 12, title: "Rework the fleet tree", disposition: "afk", blockedBy: [] },
        { number: 14, title: "Rotate bridge tokens", disposition: "hitl", blockedBy: [12] },
        ...Array.from({ length: 20 }, (_, index) => ({ number: 100 + index, title: `Extra issue ${index}`, disposition: "afk" as const, blockedBy: [] })),
      ],
      openPullRequests: [{ number: 21, title: "Fix lease recovery", reviewState: "no review yet" }],
      unreviewedMergeCount: 2,
    }),
    roadmap: async () => roadmapOf(LONG_ROADMAP),
    autoRun: () => ({ specNumber: 4, specTitle: "Bridge hardening", phase: "await-approval", currentIssue: 14, completedCount: 1, waitingOnPullRequest: 21 }),
  }), fleet, new WriteLease(), { write: async (_slice, content) => content });
  // The briefing, including its truncated roadmap and oversized-block preview.
  const rendered = await briefings.render(new AbortController().signal);
  assert.match(rendered, ascii, `non-ASCII briefing content: ${JSON.stringify(rendered.replace(/[\x20-\x7E\n]/g, ""))}`);
  // Stop-hook mailbox results.
  const stop = new ManagerStopService({ fleet, now: () => new Date(timestamp) });
  fleet.transition(workerId, { status: "completed", startedAt: timestamp, finishedAt: timestamp, exitCode: 0, lastAssistantMessage: "implemented" }, timestamp);
  fleet.recordResult(workerId, { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "implemented", telemetry: { totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3, compactionCount: 0 } }, timestamp);
  const delivered = await stop.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal);
  assert.equal(delivered.state, "results");
  assert.match(delivered.state === "results" ? delivered.additionalContext : "", ascii);
  // Intercepted-command messages and drained prompt notifications.
  const prompts = new ManagerPromptService(fleet, { spawnInteractive: async () => ({ agentId: "i-1" }) }, () => new Date("2026-07-30T14:31:00.000Z"), undefined, { kill: () => {} });
  for (const prompt of ["/brainstorm extra", "/done reason", "/auto", "/review-pr"]) {
    const result = await prompts.handle(managerId, prompt);
    assert.match(String(result.message), ascii);
  }
  const drained = await prompts.handle(managerId, "what changed?");
  assert.match(String(drained.additionalContext), ascii);
});

test("an idle project renders every section without a failure note", async () => {
  const briefings = new ManagerBriefings(sources(), new FleetRegistry(), new WriteLease());
  const rendered = await briefings.render(new AbortController().signal);
  assert.match(rendered, /No run is active/);
  assert.match(rendered, /Nothing is ready\./);
  assert.match(rendered, /## Pull requests\nNone open\./);
  assert.match(rendered, /No live agents/);
  // No carrier is a fact about the repository and the normal first-run state,
  // so it reads as work to do — deliberately not the "Unavailable" that a
  // failed fetch produces.
  assert.match(rendered, /No open issue carries `ai:todo`, so this project has no roadmap yet/);
  assert.match(rendered, /Recommend `\/update-todo`/);
  assert.doesNotMatch(rendered, /Unavailable/);
});

test("one failing boundary costs its own section, not the block", async () => {
  const fleet = new FleetRegistry(); manager(fleet);
  const briefings = new ManagerBriefings(sources({
    github: async () => { throw new Error("gh unavailable"); },
    roadmap: async () => roadmapOf("- [ ] still readable"),
  }), fleet, new WriteLease());
  const rendered = await briefings.render(new AbortController().signal);
  assert.match(rendered, /## Work\nUnavailable: gh unavailable/);
  assert.match(rendered, /still readable/);
  assert.match(rendered, /## Repository/);
});

test("a cancelled briefing names the cancellation rather than a boundary error", async () => {
  const controller = new AbortController();
  controller.abort();
  const briefings = new ManagerBriefings(sources({
    github: async () => { throw new Error("aborted"); },
  }), new FleetRegistry(), new WriteLease());
  assert.match(await briefings.render(controller.signal), /Unavailable: the request was cancelled or timed out/);
});

test("an oversized roadmap spills alone, leaving the rest of the briefing inline", async () => {
  const written: Record<string, string> = {};
  const briefings = new ManagerBriefings(
    sources({
      roadmap: async () => roadmapOf(LONG_ROADMAP),
      github: async () => ({ issues: [{ number: 12, title: "Rework the fleet tree", disposition: "afk", blockedBy: [] }], openPullRequests: [], unreviewedMergeCount: 0 }),
    }),
    new FleetRegistry(),
    new WriteLease(),
    { write: async (slice, content) => { written[slice] = content; return `C:\\runtime\\brief-${slice}.txt`; } },
  );
  const rendered = await briefings.render(new AbortController().signal);
  assert.ok(rendered.length <= HOOK_OUTPUT_LIMIT);
  // Only the roadmap went to a file. Demoting the other sections for a reason
  // that belongs to none of them would be the wrong trade.
  assert.deepEqual(Object.keys(written), ["roadmap"]);
  assert.match(rendered, /pre-rendered with its ids at C:\\runtime\\brief-roadmap\.txt/);
  assert.match(rendered, /#12 Rework the fleet tree \(afk\)/);
  assert.match(rendered, /## Repository/);
  assert.doesNotMatch(rendered, /Full briefing:/);
  // The spilled file carries the whole document, ids already computed, so
  // reading it costs one Read and no derivation.
  assert.ok((written.roadmap as string).length > ROADMAP_INLINE_LIMIT);
  assert.match(written.roadmap as string, /Roadmap task number 399/);
});

test("a small roadmap stays inline and never touches the file store", async () => {
  let writes = 0;
  const briefings = new ManagerBriefings(
    sources({ roadmap: async () => roadmapOf("- [ ] Ship the bridge", { carrierCount: 2, nearBound: true, duplicateSubjects: ["Ship the bridge"] }) }),
    new FleetRegistry(),
    new WriteLease(),
    { write: async (_slice, content) => { writes += 1; return content; } },
  );
  const rendered = await briefings.render(new AbortController().signal);
  assert.equal(writes, 0);
  // Extra carriers and a near-full document are reported, never repaired.
  assert.match(rendered, /2 issues carry `ai:todo`; #9 is in use\./);
  assert.match(rendered, /Duplicate task text in the roadmap: "Ship the bridge"/);
  assert.match(rendered, /near its size bound/);
});

test("an oversized block uses a bounded preview and file reference", async () => {
  let written = "";
  const briefings = new ManagerBriefings(
    sources({ git: async () => ({ branch: "x".repeat(HOOK_OUTPUT_LIMIT), head: "h", dirty: true }) }),
    new FleetRegistry(),
    new WriteLease(),
    { write: async (_slice, content) => { written = content; return "C:\\runtime\\brief-state.txt"; } },
  );
  const output = await briefings.render(new AbortController().signal);
  assert.ok(written.length > HOOK_OUTPUT_LIMIT);
  assert.ok(output.length <= HOOK_OUTPUT_LIMIT);
  assert.match(output, /Full briefing: C:\\runtime\\brief-state.txt/);
  // The block still closes, so the model never sees a dangling open tag.
  assert.match(output, /<\/aboard-state>$/);
});

test("the briefing is served on one route", async () => {
  const briefings = new ManagerBriefings(sources(), new FleetRegistry(), new WriteLease());
  const stop = new ManagerStopService({ fleet: new FleetRegistry() });
  const route = createManagerHookRoutes(briefings, stop);
  const call = (path: string) => route({ method: "POST", url: new URL(`http://127.0.0.1${path}`), headers: {}, body: {}, signal: new AbortController().signal });
  const served = await call("/hooks/manager/brief");
  assert.equal(served.status, 200);
  assert.match(String((served.body as { additionalContext: string }).additionalContext), /<aboard-state>/);
  // The four per-slice routes are gone; nothing may quietly keep calling them.
  for (const slice of ["git", "github", "fleet", "todo"]) {
    assert.equal((await call(`/hooks/manager/brief-${slice}`)).status, 404);
  }
});

test("the reminder carries pending tasks only, is self-dating, and leads with the marker", async () => {
  let clock = Date.parse("2026-07-30T14:32:00.000Z");
  const reminders = new RoadmapReminderService(
    { roadmap: async () => roadmapOf("- [x] Replace the locator\n- [ ] Pace the reminders") },
    { now: () => new Date(clock) },
  );
  const first = await reminders.serve(agent("manager-1"), new AbortController().signal);
  const context = String(first.additionalContext);
  // The marker leads the block so it survives the >10,000-character preview
  // rule, and so the hook's tail search finds it wherever the block is cut.
  assert.ok(context.startsWith(ROADMAP_MARKER));
  assert.match(context, /Roadmap as of 2026-07-30T14:32:00\.000Z/);
  // Pending only: the completed history is still verbatim in the window, and
  // repeating it would make the reminder grow with the project's age.
  assert.match(context, /^- \[ \] \[[0-9a-f]{4}\] Pace the reminders$/m);
  assert.doesNotMatch(context, /Replace the locator/);

  // The transcript is written asynchronously, so a duplicate clusters right
  // behind the first. The bridge refuses it.
  assert.deepEqual(await reminders.serve(agent("manager-1"), new AbortController().signal), {});
  // A different agent is not affected by another's window.
  assert.notEqual((await reminders.serve(agent("manager-2"), new AbortController().signal)).additionalContext, undefined);
  clock += 30_000;
  assert.notEqual((await reminders.serve(agent("manager-1"), new AbortController().signal)).additionalContext, undefined);
});

test("a failed reminder fetch is a non-event, and a missing roadmap still says so", async () => {
  const failing = new RoadmapReminderService({ roadmap: async () => { throw new Error("gh unavailable"); } });
  assert.deepEqual(await failing.serve(agent("manager-1"), new AbortController().signal), {});

  const empty = new RoadmapReminderService({ roadmap: async () => undefined }, { now: () => new Date("2026-07-30T14:32:00.000Z") });
  const served = String((await empty.serve(agent("manager-1"), new AbortController().signal)).additionalContext);
  assert.ok(served.startsWith(ROADMAP_MARKER));
  assert.match(served, /no open issue carries `ai:todo`/);
});

test("a due reminder rides the existing prompt drain rather than opening a second channel", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const reminders = new RoadmapReminderService(
    { roadmap: async () => roadmapOf("- [ ] Pace the reminders") },
    { now: () => new Date("2026-07-30T14:32:00.000Z") },
  );
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => ({ agentId: "i-1" }) },
    () => new Date("2026-07-30T14:31:00.000Z"),
    undefined,
    undefined,
    reminders,
  );
  // Not due: the drain behaves exactly as before, and an empty drain stays empty.
  assert.deepEqual(await prompts.handle(managerId, "what changed?"), {});

  fleet.enqueueNotification(managerId, "an auto-run merged PR #21.", at("2026-07-30T14:30:00.000Z"));
  const both = await prompts.handle(managerId, "and now?", true);
  assert.match(String(both.additionalContext), /an auto-run merged PR #21/);
  assert.match(String(both.additionalContext), /<aboard-roadmap>/);

  // A reminder with nothing else pending is still delivered on its own.
  const alone = await prompts.handle(managerId, "still there?", true);
  assert.equal(alone.additionalContext, undefined, "the 30s debounce suppresses the immediate repeat");
});

test("an intercepted command is erased, so no reminder is attached to it", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  let served = 0;
  const reminders = new RoadmapReminderService({ roadmap: async () => { served += 1; return roadmapOf("- [ ] Pace"); } });
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => ({ agentId: "i-1" }) },
    undefined, undefined, undefined, reminders,
  );
  assert.equal((await prompts.handle(managerId, "/brainstorm", true)).intercepted, true);
  assert.equal(served, 0);
});

test("the reminder route validates its caller and is absent when no service is wired", async () => {
  const briefings = new ManagerBriefings(sources(), new FleetRegistry(), new WriteLease());
  const stop = new ManagerStopService({ fleet: new FleetRegistry() });
  const request = (body: unknown): AuthenticatedBridgeRequest => ({ method: "POST", url: new URL("http://127.0.0.1/hooks/manager/roadmap"), headers: {}, body, signal: new AbortController().signal });
  assert.equal((await createManagerHookRoutes(briefings, stop)(request({ agentId: "manager-1" }))).status, 404);

  const reminders = new RoadmapReminderService({ roadmap: async () => roadmapOf("- [ ] Pace the reminders") });
  const route = createManagerHookRoutes(briefings, stop, undefined, reminders);
  assert.equal((await route(request({}))).status, 400);
  const served = await route(request({ agentId: "manager-1" }));
  assert.equal(served.status, 200);
  assert.match(String((served.body as { additionalContext: string }).additionalContext), /<aboard-roadmap>/);
});

test("Manager Stop returns pending results, waits for running work, and permits idle stop", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet); const workerId = worker(fleet, managerId);
  const running = new ManagerStopService({ fleet, now: () => new Date(timestamp) });
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal), { state: "running" });
  fleet.transition(workerId, { status: "completed", startedAt: timestamp, finishedAt: timestamp, exitCode: 0, lastAssistantMessage: "implemented" }, timestamp);
  const result: WorkerResult = { outcome: "succeeded", exitCode: 0, lastAssistantMessage: "implemented", telemetry: { totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3, compactionCount: 0 } };
  fleet.recordResult(workerId, result, timestamp);
  const delivered = await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal);
  assert.equal(delivered.state, "results");
  assert.match(delivered.state === "results" ? delivered.additionalContext : "", /^At 2026-07-30T/);
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: false }, new AbortController().signal), { state: "idle" });
  assert.deepEqual(await running.poll({ agentId: managerId, stopHookActive: true }, new AbortController().signal), { state: "idle" });
});

test("long poll observes abort and route validates stop input", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet); worker(fleet, managerId);
  const stop = new ManagerStopService({ fleet, waitForChange: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) });
  const controller = new AbortController(); const pending = stop.poll({ agentId: managerId, stopHookActive: false }, controller.signal); controller.abort();
  assert.deepEqual(await pending, { state: "idle" });
  const briefings = new ManagerBriefings(sources(), fleet, new WriteLease());
  const route = createManagerHookRoutes(briefings, stop);
  const request = (body: unknown): AuthenticatedBridgeRequest => ({ method: "POST", url: new URL("http://127.0.0.1/hooks/manager/stop"), headers: {}, body, signal: new AbortController().signal });
  assert.equal((await route(request({ agentId: managerId }))).status, 400);
});

test("Python Manager hook silently self-guards non-addressed sessions", () => {
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  for (const env of [{}, { ABOARD_AGENT_ID: "worker", ABOARD_AGENT_TYPE: "implementer" }]) {
    const result = spawnSync("uv", ["run", "--no-project", "python", script, "manager-brief-git"], { input: "{}", encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("hook registration covers cold start, resume, and explicit timeouts in one briefing call", async () => {
  const hooks = await import("node:fs/promises").then(({ readFile }) => readFile(join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard-hooks.json"), "utf8"));
  const parsed = JSON.parse(hooks) as any;
  // Index 0 is the proof-of-life session-start hook (pid report); index 1 is
  // the manager briefing call.
  const proofOfLife = parsed.SessionStart[0];
  assert.match(proofOfLife.matcher, /startup/); assert.match(proofOfLife.matcher, /resume/);
  assert.deepEqual(proofOfLife.hooks.map((hook: any) => hook.args.at(-1)), ["session-start"]);
  const brief = parsed.SessionStart[1];
  assert.match(brief.matcher, /startup/); assert.match(brief.matcher, /resume/);
  // One hook, so one `uv` spawn and one bridge round trip per session start.
  assert.deepEqual(brief.hooks.map((hook: any) => hook.timeout), [120]);
  assert.deepEqual(brief.hooks.map((hook: any) => hook.args.at(-1)), ["manager-brief"]);
  assert.deepEqual(parsed.SessionEnd[0].hooks.map((hook: any) => hook.args.at(-1)), ["session-end"]);
  assert.equal(parsed.Stop[0].hooks[0].timeout, 3600);
  assert.equal(parsed.UserPromptSubmit[0].hooks[0].timeout, 60);
});

test("Manager prompt route launches both interactive command types and drains ordered notifications once", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const launches: unknown[] = [];
  let next = 1;
  const prompts = new ManagerPromptService(fleet, { spawnInteractive: async (input) => {
    launches.push(input); return { agentId: `interactive-${next++}` };
  } }, () => new Date("2026-07-30T14:31:00.000Z"));
  assert.deepEqual(await prompts.handle(managerId, "/brainstorm"), { intercepted: true, message: "Brainstorm session launched and focused." });
  assert.deepEqual(await prompts.handle(managerId, "/general-purpose"), { intercepted: true, message: "General-purpose session launched and focused." });
  // Neither launch carries a prompt: an interactive terminal has a user in
  // front of it, and filler would burn a turn before the conversation starts.
  assert.deepEqual(launches, [
    { type: "brainstormer", description: "interactive brainstorm session" },
    { type: "general-purpose", description: "general purpose interactive session" },
  ]);
  const drained = await prompts.handle(managerId, "what is the status?");
  assert.match(String(drained.additionalContext), /At 2026-07-30T14:31:00.000Z: you started a brainstormer \(agent interactive-1\)/);
  assert.match(String(drained.additionalContext), /general-purpose session \(agent interactive-2\)/);
  assert.ok(String(drained.additionalContext).indexOf("interactive-1") < String(drained.additionalContext).indexOf("interactive-2"));
  assert.deepEqual(await prompts.handle(managerId, "and now?"), {});
});

test("/done closes the invoking Manager terminal without waking the model", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const generalPurposeId = agent("general-purpose-1");
  fleet.register({
    identity: { agentId: generalPurposeId, type: "general-purpose" }, sessionId: session("bdb05c21-eb37-4147-b5cb-6a5ca2592146"),
    terminal: { terminalId: terminal("general-purpose-terminal"), name: "general-purpose" }, lifecycle: { status: "starting", startedAt: timestamp },
    resultDelivery: { mode: "none" }, telemetry: { totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0, compactionCount: 0 },
  }, timestamp);
  fleet.transition(generalPurposeId, { status: "running", startedAt: timestamp }, timestamp);
  const killed: TerminalId[] = [];
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => assert.fail("/done must not launch an agent") },
    undefined,
    undefined,
    { kill: (terminalId) => killed.push(terminalId) },
  );
  assert.deepEqual(await prompts.handle(managerId, "/done"), { intercepted: true, message: "Closing this terminal." });
  assert.deepEqual(await prompts.handle(generalPurposeId, "/done"), { intercepted: true, message: "Closing this terminal." });
  assert.deepEqual(killed, [terminal("manager-terminal"), terminal("general-purpose-terminal")]);
  assert.match(String((await prompts.handle(managerId, "/done trailing text")).message), /text you typed after it was not sent/);
});

test("interactive commands take no arguments and say so rather than silently dropping text", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const launches: unknown[] = [];
  const prompts = new ManagerPromptService(fleet, { spawnInteractive: async (input) => {
    launches.push(input); return { agentId: "interactive-1" };
  } });
  const result = await prompts.handle(managerId, "/brainstorm caching layer");
  assert.equal(result.intercepted, true);
  assert.match(String(result.message), /takes no arguments/);
  assert.match(String(result.message), /type it in the new terminal/);
  // Still intercepted: leaking "/brainstorm caching layer" into the Manager's
  // context is worse than declining to forward the topic.
  assert.deepEqual(launches, [{ type: "brainstormer", description: "interactive brainstorm session" }]);
});

test("/auto and /review-pr are performed by the extension, reported to the user, and queued for the Manager", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const started: string[] = [];
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => assert.fail("an extension action must not launch an agent") },
    () => new Date("2026-07-30T14:31:00.000Z"),
    {
      startAutoRun: async () => { started.push("auto"); return { started: true, spec: { number: 12, title: "Offline sync" }, issues: [{ number: 34 }, { number: 35 }] }; },
      reviewPullRequest: async () => { started.push("review"); return { action: "focused", prNumber: 56, type: "implementer" }; },
    },
  );
  const auto = await prompts.handle(managerId, "/auto");
  assert.equal(auto.intercepted, true);
  assert.equal(auto.message, "auto-run started on spec #12 with 2 issues.");
  const review = await prompts.handle(managerId, "/review-pr");
  assert.equal(review.message, "Focused the implementer terminal for PR #56.");
  assert.deepEqual(started, ["auto", "review"]);

  // The Manager is told later, batched into the next real prompt, rather than
  // being woken to narrate a mechanical action.
  const drained = await prompts.handle(managerId, "what changed?");
  assert.match(String(drained.additionalContext), /you ran \/auto: auto-run started on spec #12/);
  assert.match(String(drained.additionalContext), /you ran \/review-pr: Focused the implementer terminal/);
});

test("an extension action reports a refusal verbatim and drops trailing arguments", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const prompts = new ManagerPromptService(
    fleet,
    { spawnInteractive: async () => assert.fail("no agent") },
    () => new Date("2026-07-30T14:31:00.000Z"),
    {
      startAutoRun: async () => ({ started: false, reason: "the working tree is not clean: src/a.ts" }),
      reviewPullRequest: async () => ({ action: "none" }),
    },
  );
  const refused = await prompts.handle(managerId, "/auto now please");
  assert.match(String(refused.message), /auto-run did not start: the working tree is not clean: src\/a\.ts/);
  assert.match(String(refused.message), /takes no arguments/);
});

test("an unavailable extension action is reported instead of falling through to the Manager", async () => {
  const fleet = new FleetRegistry(); const managerId = manager(fleet);
  const prompts = new ManagerPromptService(fleet, { spawnInteractive: async () => assert.fail("no agent") });
  const result = await prompts.handle(managerId, "/auto");
  assert.equal(result.intercepted, true);
  assert.match(String(result.message), /cannot handle \/auto right now/);
});

async function runPromptHook(responseStatus: number, responseBody: unknown, prompt: string, token = "secret", agentType = "manager"): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  const child = spawn("uv", ["run", "--no-project", "python", script, "manager-prompt"], {
    env: { ...process.env, ABOARD_AGENT_ID: "manager-1", ABOARD_AGENT_TYPE: agentType, ABOARD_BRIDGE_PORT: String(address.port), ABOARD_BRIDGE_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return { status, stdout, stderr };
}

test("Python prompt hook erases successful and failed commands with exact output channels", async () => {
  const success = await runPromptHook(200, { intercepted: true, message: "Brainstorm session launched and focused." }, "/brainstorm caching layer");
  assert.deepEqual(success, { status: 2, stdout: "", stderr: `${EOL}${EOL}Brainstorm session launched and focused.` });
  const generalPurposeDone = await runPromptHook(200, { intercepted: true, message: "Closing this terminal." }, "/done", "secret", "general-purpose");
  assert.deepEqual(generalPurposeDone, { status: 2, stdout: "", stderr: `${EOL}${EOL}Closing this terminal.` });
  const authFailure = await runPromptHook(401, { ok: false }, "/general-purpose", "wrong-token");
  assert.equal(authFailure.status, 2); assert.equal(authFailure.stdout, ""); assert.ok(authFailure.stderr.startsWith(`${EOL}${EOL}Aboard did not launch the requested session:`));
});

test("Python prompt hook injects a drained queue on a real prompt", async () => {
  const context = "Since your last message:\nAt 2026-07-30T14:31:00.000Z: launched one.\nAt 2026-07-30T14:36:00.000Z: launched two.";
  const result = await runPromptHook(200, { additionalContext: context }, "what changed?");
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
});

test("aboard-owned command skills are user-only shims and builtins have no aboard definition", async () => {
  const { readFile, access } = await import("node:fs/promises");
  for (const name of ["brainstorm", "general-purpose", "done", "auto", "review-pr"]) {
    const skill = await readFile(join(process.cwd(), "assets", "scaffold", ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /disable-model-invocation: true/); assert.match(skill, new RegExp(`/${name}`));
    // No argument-hint: these commands are argumentless, and hinting otherwise
    // invites a topic the launch deliberately does not forward.
    assert.doesNotMatch(skill, /argument-hint:/);
    // The body is reachable only when the hook failed to intercept, so it must
    // read as an error notice: an empty body leaves the model to invent a
    // response, and any instruction resembling the command would have it
    // simulate work the extension alone can perform. Equally, the reader is a
    // user of aboard, not its developer: the notice must steer them to the
    // extension's own controls rather than into debugging the installation.
    const body = skill.replace(/^---\n[\s\S]*?\n---\n/u, "").replace(/<!--[\s\S]*?-->/gu, "").trim();
    assert.notEqual(body, "", `${name} SKILL.md must explain the hook failure rather than leave an empty body`);
    assert.match(body, /is broken — report that to the user and stop/, `${name} SKILL.md body must announce it is an error state`);
    assert.match(body, /Do not try to carry it out yourself/, `${name} SKILL.md body must forbid simulating the command`);
    assert.match(body, /except if the user explicitly asks/, `${name} SKILL.md body must forbid fixing the installation unprompted`);
    assert.match(body, /Reset \.aboard\//, `${name} SKILL.md body must steer the user to aboard's controls, not internal causes`);
  }
  await assert.rejects(access(join(process.cwd(), "assets", "scaffold", ".aboard", "agents", "general-purpose.md")));
});

test("Python prompt hook blocks both intercepted commands and never blocks other routes", async () => {
  for (const prompt of ["/general-purpose", "/general-purpose fix the parser", "/brainstorm", "/brainstorm caching layer", "/done", "/done close now", "/auto", "/review-pr", "/auto the next spec"]) {
    const result = await runPromptHook(500, { error: "boom" }, prompt);
    assert.equal(result.status, 2, `${prompt} must erase the prompt even when the bridge fails`);
    assert.equal(result.stdout, "");
  }
  // A bridge that wrongly reports interception on a Stop poll must not exit 2:
  // that would refuse to let the Manager stop, looping the session forever.
  const script = join(process.cwd(), "assets", "scaffold", ".claude", "hooks", "aboard_hook.py");
  const stop = spawnSync("uv", ["run", "--no-project", "python", script, "manager-stop"], {
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
    encoding: "utf8",
    env: { ...process.env, ABOARD_AGENT_ID: "manager-1", ABOARD_AGENT_TYPE: "manager" },
  });
  assert.equal(stop.status, 0); assert.equal(stop.stderr, "");
});
