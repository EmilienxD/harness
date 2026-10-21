import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createPiFixture } from "../core/pi-fixture.js";
import { piLegacyDirectoryWarningCount } from "../core/pi-startup.js";
import { createPiToolScenario } from "../core/pi-scenario.js";
import { piSmokeScenario, runPiSmokeJourney, stagePiProbe } from "../tools/pi-smoke/run.js";

test("Pi RPC launch overrides reject paid providers and invalid thinking levels before spawning", async () => {
  const fixture = await createPiFixture(piSmokeScenario);
  try {
    assert.throws(() => fixture.rpc({ model: "openai/gpt-6.1-sol" }), /fake provider/u);
    assert.throws(() => fixture.rpc({ thinkingLevel: "invalid" }), /thinking level/u);
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});

test("installed Pi startup detects project and user legacy hooks directories", { timeout: 90_000 }, async () => {
  const fixture = await createPiFixture(piSmokeScenario);
  try {
    assert.equal(await piLegacyDirectoryWarningCount(fixture.workspace), 0);
    await mkdir(join(fixture.workspace.projectRoot, ".pi", "hooks"));
    assert.equal(await piLegacyDirectoryWarningCount(fixture.workspace), 1);
    await mkdir(join(fixture.workspace.agentDir, "hooks"));
    assert.equal(await piLegacyDirectoryWarningCount(fixture.workspace), 2);
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});

for (const mode of ["json", "rpc"] as const) {
  test(`real Pi ${mode} executes native read/write/edit and honors a project extension denial`, { timeout: 90_000 }, async () => {
    const result = await runPiSmokeJourney(mode);
    assert.equal(result.status, "success");
    assert.equal(result.bytes, "after\n");
    assert.equal(result.blockedFileExists, false);
    assert.deepEqual(result.checkpoints, ["write", "read", "edit", "blocked-write", "complete"]);
    assert.deepEqual(result.toolExecutions, [{ name: "write", isError: false }, { name: "read", isError: false }, { name: "edit", isError: false }, { name: "write", isError: true }]);
    assert.ok(result.eventTypes.includes("agent_settled"));
    assert.equal(result.assistantStopReasons.at(-1), "stop");
    assert.equal(result.inferenceRequests, 5);
    assert.equal(result.unexpectedRequests, 0);
  });
}

test("real Pi RPC deterministic commands and reload use zero inference requests", { timeout: 90_000 }, async () => {
  const fixture = await createPiFixture(piSmokeScenario);
  try {
    await stagePiProbe(fixture.workspace.projectRoot);
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/e2e-touch")).status, "handled");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, "command-result.txt"), "utf8"), "command\n");
    assert.equal((await rpc.prompt("/e2e-reload")).status, "handled");
    assert.equal((await rpc.prompt("/e2e-touch")).status, "handled");
    const records = (await readFile(join(fixture.workspace.projectRoot, "probe-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; reason: string });
    assert.ok(records.some((record) => record.type === "session_start" && record.reason === "startup"));
    assert.ok(records.some((record) => record.type === "session_start" && record.reason === "reload"));
    assert.ok(records.some((record) => record.type === "session_shutdown" && record.reason === "reload"));
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
  await assert.rejects(access(fixture.root));
});

test("real Pi resumes the exact persisted JSON session through the fake Responses provider", { timeout: 90_000 }, async () => {
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-resume", marker: "[E2E:pi-resume]", steps: [] }));
  try {
    const first = await fixture.runJson({ prompt: "[E2E:pi-resume]", sessionId: "harness-resume" });
    assert.equal(first.status, "success");
    const files = await readdir(fixture.workspace.sessionsDir);
    assert.equal(files.length, 1);
    const sessionFile = join(fixture.workspace.sessionsDir, files[0]!);
    const second = await fixture.runJson({ prompt: "Continue the fixture.", sessionFile });
    assert.equal(second.status, "success");
    assert.equal(second.events.find((event) => event.type === "session")?.id, "harness-resume");
    assert.equal(fixture.assertions().inferenceRequests, 2);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});

test("real Pi provider failure is not success even when its process exits zero; diagnostics omit bodies", { timeout: 90_000 }, async () => {
  const fixture = await createPiFixture(piSmokeScenario);
  try {
    const run = await fixture.runJson({ prompt: "unknown-fixture-private-canary" });
    assert.equal(run.status, "failed");
    assert.ok(run.assistantStopReasons.includes("error"));
    assert.equal(fixture.assertions().inferenceRequests, 1);
    assert.equal(fixture.assertions().unexpectedRequests, 1);
    const diagnostics = await readFile(join(fixture.root, "structural-diagnostics.json"), "utf8");
    assert.equal(diagnostics.includes("unknown-fixture-private-canary"), false);
    assert.equal(diagnostics.includes(fixture.workspace.env.HARNESS_E2E_PI_KEY!), false);
    assert.equal(JSON.parse(diagnostics).upstreamMode, "forbidden");
  } finally { await fixture.close(); }
});

test("real Pi discovers an explicit-only project skill and runs its native command", { timeout: 90_000 }, async () => {
  const scenario = createPiToolScenario({ name: "pi-skill", marker: "[E2E:pi-skill]", steps: [{ checkpoint: "skill-write", tool: "write", input: { path: "skill-result.txt", content: "skill\n" } }] });
  const fixture = await createPiFixture(scenario);
  try {
    const skill = join(fixture.workspace.projectRoot, ".pi", "skills", "e2e-artifact");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: e2e-artifact\ndescription: Write the E2E artifact on explicit invocation.\ndisable-model-invocation: true\n---\n\n[E2E:pi-skill]\nWrite the fixture artifact.\n", "utf8");
    const run = await fixture.runJson({ prompt: "/skill:e2e-artifact" });
    assert.equal(run.status, "success");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, "skill-result.txt"), "utf8"), "skill\n");
    assert.equal(fixture.assertions().inferenceRequests, 2);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});

test("real Pi RPC abort settles as aborted and cleans up the in-flight local request", { timeout: 90_000 }, async () => {
  let started!: () => void;
  let release!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scenario = createPiToolScenario({ name: "pi-abort", marker: "[E2E:pi-abort]", steps: [] });
  const fixture = await createPiFixture({ ...scenario, transition: async (request) => { started(); await gate; return scenario.transition(request); } });
  try {
    const rpc = fixture.rpc();
    const running = rpc.prompt("[E2E:pi-abort]");
    await inFlight;
    assert.equal((await rpc.request("abort")).success, true);
    const run = await running;
    assert.equal(run.status, "aborted");
    assert.ok(run.eventTypes.includes("agent_settled"));
    assert.equal(fixture.assertions().inferenceRequests, 1);
  } finally { release(); await fixture.close(); }
});
