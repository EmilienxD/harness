import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ROADMAP_MARKER } from "../src/bridge/manager-hooks.js";

const SCRIPT = join(process.cwd(), "assets", "scaffold", ".aboard", "scripts", "aboard_hook.py");

interface HookRun {
  readonly route: string;
  readonly transcript?: string;
  readonly span?: string;
  readonly agentType?: string;
  readonly agentId?: string;
  readonly event?: string;
  readonly prompt?: string;
  readonly response?: unknown;
}

interface HookOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly unknown[];
}

/**
 * The shipped hook against a real transcript file, in a real child process. It
 * must be spawned asynchronously: the server it may call runs in *this*
 * process, so a synchronous spawn would block the event loop that answers it.
 */
async function runHook(options: HookRun): Promise<HookOutcome> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(options.response ?? { additionalContext: `${ROADMAP_MARKER}\nRoadmap as of now\n</aboard-roadmap>` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const child = spawn("uv", ["run", "--no-project", "python", SCRIPT, options.route], {
    env: {
      ...process.env,
      ABOARD_AGENT_ID: options.agentId ?? "manager-1",
      ABOARD_AGENT_TYPE: options.agentType ?? "manager",
      ABOARD_BRIDGE_PORT: String(address.port),
      ABOARD_BRIDGE_TOKEN: "secret",
      ...(options.span === undefined ? {} : { ABOARD_ROADMAP_REMINDER_BYTES: options.span }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    hook_event_name: options.event ?? "PostToolUse",
    ...(options.transcript === undefined ? {} : { transcript_path: options.transcript }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  }));
  const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return { status, stdout, stderr, requests };
}

/** Roughly 40 KB of transcript, with or without a roadmap injection at the top. */
async function transcript(context: { after(fn: () => void | Promise<void>): void }, marked: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aboard-transcript-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  // The marker as Claude Code actually persists it: once inside the raw
  // `stdout` string of a hook_success row, once in an unescaped content array.
  const head = marked
    ? `${JSON.stringify({ type: "system", subtype: "hook_success", stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: `${ROADMAP_MARKER}\nRoadmap\n</aboard-roadmap>` } }) })}\n`
    : "";
  const filler = `${JSON.stringify({ type: "assistant", text: "x".repeat(2_000) })}\n`;
  await writeFile(path, `${head}${filler.repeat(20)}`, "utf8");
  return path;
}

test("the reminder hook is silent for every session it does not address", async (context) => {
  const path = await transcript(context, false);
  for (const options of [
    { agentId: "", agentType: "manager" },
    { agentType: "implementer" },
    { agentType: "webresearcher" },
    { agentType: "brainstormer" },
  ]) {
    const result = await runHook({ route: "manager-roadmap", transcript: path, span: "100000", ...options });
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr, requests: result.requests.length },
      { status: 0, stdout: "", stderr: "", requests: 0 },
      JSON.stringify(options),
    );
  }
});

test("a marker inside the tail window costs one bounded read and nothing else", async (context) => {
  const marked = await transcript(context, true);
  // The marker is at the top of ~40 KB; a 200 KB window still contains it, so
  // no reminder is due and the hook never opens a connection.
  const inside = await runHook({ route: "manager-roadmap", transcript: marked, span: "200000" });
  assert.deepEqual({ status: inside.status, stdout: inside.stdout, requests: inside.requests.length }, { status: 0, stdout: "", requests: 0 });

  // The same transcript with a 10 KB window: the marker has fallen out of the
  // tail, so one is due. This is the whole pacing rule — no counter, no state.
  const outside = await runHook({ route: "manager-roadmap", transcript: marked, span: "10000" });
  assert.equal(outside.status, 0);
  assert.deepEqual(outside.requests, [{ agentId: "manager-1" }]);
  const emitted = JSON.parse(outside.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(emitted.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(emitted.hookSpecificOutput.additionalContext.startsWith(ROADMAP_MARKER));
});

test("an unset span, an unreadable transcript, and a debounced answer all stay silent", async (context) => {
  const unmarked = await transcript(context, false);
  // No span in the environment: the reminder is off entirely.
  const off = await runHook({ route: "manager-roadmap", transcript: unmarked });
  assert.deepEqual({ status: off.status, requests: off.requests.length }, { status: 0, requests: 0 });
  assert.deepEqual((await runHook({ route: "manager-roadmap", transcript: unmarked, span: "0" })).requests, []);
  // Every uncertain answer resolves to "not due": injecting on a transcript we
  // could not read would be guessing.
  assert.deepEqual((await runHook({ route: "manager-roadmap", transcript: join(unmarked, "nope.jsonl"), span: "10000" })).requests, []);
  assert.deepEqual((await runHook({ route: "manager-roadmap", span: "10000" })).requests, []);
  // The bridge debounced it: nothing to print, and nothing to say about it.
  const debounced = await runHook({ route: "manager-roadmap", transcript: unmarked, span: "10000", response: {} });
  assert.deepEqual({ status: debounced.status, stdout: debounced.stdout, requests: debounced.requests.length }, { status: 0, stdout: "", requests: 1 });
});

test("UserPromptSubmit carries the same verdict with the prompt rather than calling twice", async (context) => {
  const unmarked = await transcript(context, false);
  const due = await runHook({
    route: "manager-prompt", event: "UserPromptSubmit", prompt: "what changed?", transcript: unmarked, span: "10000",
    response: { additionalContext: "Since your last message: nothing." },
  });
  assert.equal(due.status, 0);
  assert.deepEqual(due.requests, [{ agentId: "manager-1", prompt: "what changed?", roadmapDue: true }]);

  const marked = await transcript(context, true);
  const notDue = await runHook({
    route: "manager-prompt", event: "UserPromptSubmit", prompt: "what changed?", transcript: marked, span: "200000",
    response: { additionalContext: "Since your last message: nothing." },
  });
  assert.deepEqual(notDue.requests, [{ agentId: "manager-1", prompt: "what changed?" }]);

  // An intercepted command erases the turn, so there is nothing to attach a
  // reminder to and the flag is never sent.
  const intercepted = await runHook({
    route: "manager-prompt", event: "UserPromptSubmit", prompt: "/auto", transcript: unmarked, span: "10000",
    response: { intercepted: true, message: "auto-run started." },
  });
  assert.equal(intercepted.status, 2);
  assert.deepEqual(intercepted.requests, [{ agentId: "manager-1", prompt: "/auto" }]);
});

test("the reminder is registered on PostToolUse with no matcher, alongside the Agent telemetry hook", async () => {
  const parsed = JSON.parse(await readFile(join(process.cwd(), "assets", "scaffold", ".aboard", "aboard-hooks.json"), "utf8")) as {
    PostToolUse: { matcher?: string; hooks: { args: string[]; timeout?: number }[] }[];
    SessionStart: { matcher?: string; hooks: { args: string[] }[] }[];
  };
  const reminder = parsed.PostToolUse.find((entry) => entry.hooks.some((hook) => hook.args.at(-1) === "manager-roadmap"));
  assert.ok(reminder !== undefined, "PostToolUse must register the roadmap reminder");
  // No matcher: restricting it to the Manager's tool list would skip only Skill,
  // in exchange for a regex that must stay in sync with it.
  assert.equal(reminder.matcher, undefined);
  assert.equal(reminder.hooks[0]?.timeout, 60);
  assert.equal(parsed.PostToolUse.some((entry) => entry.matcher === "Agent"), true);

  // The compact briefing re-injects the roadmap, which is what resets the
  // reminder window with no separate rule — so `compact` must stay matched.
  const brief = parsed.SessionStart.find((entry) => entry.hooks.some((hook) => hook.args.at(-1) === "manager-brief"));
  assert.match(brief?.matcher ?? "", /compact/);
});
