import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario, type PiScenarioStep } from "../../core/pi-scenario.js";

export type PathGuard = "on-read-reminder" | "on-edit-reminder" | "on-edit-block";

export async function runPiPathGuardJourney(packageName: PathGuard, mode: "json" | "rpc", scope: "project" | "user") {
  let project = "";
  const steps: PiScenarioStep[] = packageName === "on-edit-block" ? [
    { checkpoint: "deny", tool: "write", input: { path: "target.txt", content: "forbidden\n" } },
    { checkpoint: "retry-after-delivery", tool: "edit", input: { path: "target.txt", oldText: "before", newText: "after" } },
  ] : packageName === "on-edit-reminder" ? [
    { checkpoint: "edit-and-remind", tool: "write", input: { path: "target.txt", content: "after\n" } },
    { checkpoint: "cooldown", tool: "edit", input: { path: "target.txt", oldText: "after", newText: "second" } },
    { checkpoint: "read-guide", tool: "read", input: { path: "guide.md" } },
    { checkpoint: "read-suppresses-reminder", tool: "edit", input: { path: "target.txt", oldText: "second", newText: "after" } },
    { checkpoint: "failed-edit", tool: "edit", input: { path: "target.txt", oldText: "absent", newText: "bad" } },
  ] : [
    { checkpoint: "read-and-remind", tool: "read", input: { path: "target.txt" } },
    { checkpoint: "repeat-read", tool: "read", input: { path: "target.txt", limit: 1 } },
    { checkpoint: "failed-read", tool: "read", input: { path: "target.txt", offset: 999 } },
    { checkpoint: "read-guide", tool: "read", input: { path: "guide.md" } },
  ];
  const marker = `[E2E:pi-${packageName}]`;
  const fixture = await createPiFixture(createPiToolScenario({ name: `pi-${packageName}`, marker, steps }));
  try {
    project = fixture.workspace.projectRoot;
    await writeFile(join(project, "target.txt"), "before\n");
    await writeFile(join(project, "guide.md"), "Follow project conventions: café, 中文, 😀.\n");
    await runFixtureInstaller(fixture.workspace, "install", [packageName], { scope, dryRun: true });
    assert.equal(existsSync(join(project, ".pi", "hooks", "pi-support")), false);
    await runFixtureInstaller(fixture.workspace, "install", [packageName], { scope });
    await runFixtureInstaller(fixture.workspace, "install", [packageName], { scope });
    const platformRoot = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const policy = scope === "project" ? join(project, ".harness", "guards", `${packageName}.toml`) : join(platformRoot, "hooks", `${packageName}.toml`);
    await writeFile(policy, 'version = 1\n[[rules]]\npatterns = ["target.txt"]\nrequire = ["guide.md"]\n');
    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    const ends = run.events.filter((event) => event.type === "tool_execution_end");
    const contentCounts = ends.map((event) => (event.result as { content: unknown[] }).content.length);
    if (packageName === "on-read-reminder") assert.deepEqual(contentCounts, [2, 2, 1, 1]);
    if (packageName === "on-edit-reminder") assert.deepEqual(contentCounts, [2, 1, 1, 1, 1]);
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), packageName === "on-edit-block" ? [true, false] : packageName === "on-edit-reminder" ? [false, false, false, false, true] : [false, false, true, false]);
    assert.equal(await readFile(join(project, "target.txt"), "utf8"), packageName === "on-read-reminder" ? "before\n" : "after\n");
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    // Native read structured output survives additive guidance.
    if (packageName === "on-read-reminder") assert.equal((ends[0]!.result as { structuredContent: unknown }).structuredContent, "before\n");
    await runFixtureInstaller(fixture.workspace, "uninstall", [packageName], { scope });
    await assert.rejects(access(join(platformRoot, "extensions", `harness-${packageName}`, "index.ts")));
    await assert.rejects(access(join(platformRoot, "hooks", "pi-support", "bridge.ts")));
    assert.equal(await readFile(policy, "utf8"), 'version = 1\n[[rules]]\npatterns = ["target.txt"]\nrequire = ["guide.md"]\n');
    return { version: fixture.version, mode, scope, package: packageName, inferenceRequests: steps.length + 1, status: run.status };
  } finally { await fixture.close(); }
}

export async function runPiPartialReadJourney(mode: "json" | "rpc") {
  let project = "";
  const marker = "[E2E:pi-partial-reads]";
  const steps: PiScenarioStep[] = [
    { checkpoint: "failed-read", tool: "read", input: { path: "guide.md", offset: 9999 } },
    { checkpoint: "failed-read-denied", tool: "write", input: { path: "blocked.txt", content: "bad\n" } },
    { checkpoint: "partial-read", tool: "read", input: { path: "guide.md", limit: 1 } },
    { checkpoint: "partial-read-denied", tool: "write", input: { path: "blocked.txt", content: "bad\n" } },
    { checkpoint: "remaining-read", tool: "read", input: { path: "guide.md", offset: 2 } },
    { checkpoint: "complete-read-allows", tool: "write", input: { path: "blocked.txt", content: "after\n" } },
  ];
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-partial-reads", marker, steps }));
  try {
    project = fixture.workspace.projectRoot;
    await runFixtureInstaller(fixture.workspace, "install", ["on-edit-block"]);
    await writeFile(join(project, ".harness", "guards", "on-edit-block.toml"), 'version = 1\n[[rules]]\npatterns = ["blocked.txt"]\nrequire = ["guide.md"]\n');
    // Too large to inline in a denial, small enough for a complete native read.
    await writeFile(join(project, "guide.md"), "first line\n" + "conventions\n".repeat(1200));
    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [true, true, false, true, false, false]);
    assert.equal(await readFile(join(project, "blocked.txt"), "utf8"), "after\n");
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    const sessionFiles = await readdir(fixture.workspace.sessionsDir);
    const sessionFile = join(fixture.workspace.sessionsDir, sessionFiles[0]!);
    const resumed = await fixture.runJson({ prompt: "Continue.", sessionFile });
    assert.equal(resumed.status, "success");
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 2);
  } finally { await fixture.close(); }
}

export async function runPiGuardStateJourney() {
  const marker = "[E2E:pi-guard-state]";
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-guard-state", marker,
    steps: [{ checkpoint: "nested-tools", tool: "guard_probe", input: {} }],
  }));
  try {
    const project = fixture.workspace.projectRoot;
    await runFixtureInstaller(fixture.workspace, "install", ["on-edit-block", "on-edit-reminder", "on-read-reminder"]);
    await writeFile(join(project, ".harness", "guards", "on-edit-block.toml"), 'version = 1\n[[rules]]\npatterns = ["blocked.txt"]\nrequire = ["guide.md"]\n');
    await writeFile(join(project, "guide.md"), "conventions\n".repeat(1200));
    const probe = join(project, ".pi", "extensions", "state-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), await readFile(join(await findHarnessRoot(), "tests", "e2e", "tools", "pi-path-guards", "state-probe.ts.txt")));
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/guard-anchor")).status, "handled");
    assert.equal((await rpc.prompt(marker)).status, "success");
    assert.deepEqual(JSON.parse(await readFile(join(project, "probe-result.json"), "utf8")), { firstError: true, readError: false, retryError: false });
    assert.equal((await rpc.prompt("/guard-inspect")).status, "handled");
    const before = JSON.parse(await readFile(join(project, "receipt-count.json"), "utf8"));
    assert.ok(before.count > 0);
    assert.equal(before.nested, true);
    assert.equal((await rpc.prompt("/guard-reload")).status, "handled");
    assert.equal((await rpc.prompt("/guard-inspect")).status, "handled");
    assert.deepEqual(JSON.parse(await readFile(join(project, "receipt-count.json"), "utf8")), before);
    assert.equal((await rpc.prompt("/guard-back")).status, "handled");
    assert.equal((await rpc.prompt("/guard-inspect")).status, "handled");
    assert.equal(JSON.parse(await readFile(join(project, "receipt-count.json"), "utf8")).count, 0);
    assert.equal((await rpc.prompt(marker)).status, "success");
    assert.deepEqual(JSON.parse(await readFile(join(project, "probe-result.json"), "utf8")), { firstError: true, readError: false, retryError: false });
    assert.equal(await readFile(join(project, "blocked.txt"), "utf8"), "after\n");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    // A coupled bridge survives removal of one dependent, then disappears with the last one.
    await runFixtureInstaller(fixture.workspace, "uninstall", ["on-edit-block"]);
    await access(join(project, ".pi", "hooks", "pi-support", "bridge.ts"));
    await runFixtureInstaller(fixture.workspace, "uninstall", ["on-edit-reminder", "on-read-reminder"]);
    await assert.rejects(access(join(project, ".pi", "hooks", "pi-support", "bridge.ts")));
  } finally { await fixture.close(); }
}

export async function runPiShellReadJourney() {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const partial = shell === "powershell" ? "Get-Content -TotalCount 1 guide.md" : "head -n 1 guide.md";
  const full = shell === "powershell" ? "Get-Content -Raw guide.md" : "cat guide.md";
  const target = shell === "powershell" ? "Get-Content -Raw target.txt" : "cat target.txt";
  const marker = "[E2E:pi-shell-reads]";
  const steps: PiScenarioStep[] = [
    { checkpoint: "shell-reminder", tool: shell, input: { command: target } },
    { checkpoint: "shell-partial", tool: shell, input: { command: partial } },
    { checkpoint: "partial-denied", tool: "write", input: { path: "blocked.txt", content: "bad\n" } },
    { checkpoint: "shell-complete", tool: shell, input: { command: full } },
    { checkpoint: "complete-allows", tool: "write", input: { path: "blocked.txt", content: "after\n" } },
  ];
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-shell-reads", marker, steps }));
  try {
    const project = fixture.workspace.projectRoot;
    await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "harness-e2e", defaultModel: "pi-e2e", defaultTools: ["read", "write", "edit", shell] }));
    await runFixtureInstaller(fixture.workspace, "install", ["on-read-reminder", "on-edit-block"]);
    await writeFile(join(project, "target.txt"), "before\n");
    await writeFile(join(project, "guide.md"), "conventions\n".repeat(1200));
    for (const [packageName, path] of [["on-read-reminder", "target.txt"], ["on-edit-block", "blocked.txt"]]) {
      await writeFile(join(project, ".harness", "guards", `${packageName}.toml`), `version = 1\n[[rules]]\npatterns = ["${path}"]\nrequire = ["guide.md"]\n`);
    }
    const run = await fixture.runJson({ prompt: marker });
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.toolExecutions.map((event) => event.isError), [false, false, true, false, false]);
    assert.equal((run.events.find((event) => event.type === "tool_execution_end")!.result as { content: unknown[] }).content.length, 2);
    assert.equal(await readFile(join(project, "blocked.txt"), "utf8"), "after\n");
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
}

export async function runPiGuardResumeJourney() {
  const marker = "[E2E:pi-guard-resume]";
  const next = "[E2E:pi-guard-resume-next]";
  const scenario = createPiToolScenario({ name: "pi-guard-resume", marker, steps: [
    { checkpoint: "read-before-resume", tool: "read", input: { path: "guide.md" } },
    { checkpoint: "write-after-resume", tool: "write", input: { path: "blocked.txt", content: "after\n" } },
  ] });
  const fixture = await createPiFixture({ ...scenario, transition: (request) => {
    const continuing = request.input.some((item) => item.role === "user" && JSON.stringify(item.content).includes(next));
    const result = scenario.transition(request);
    if (!continuing && request.input.filter((item) => item.type === "function_call_output").length === 1) return {
      scenario: "pi-guard-resume", checkpoint: "pause",
      output: { type: "message", id: "msg_guard_resume_pause", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture paused.", annotations: [] }] },
    };
    return result;
  } });
  try {
    const project = fixture.workspace.projectRoot;
    await runFixtureInstaller(fixture.workspace, "install", ["on-edit-block"]);
    await writeFile(join(project, ".harness", "guards", "on-edit-block.toml"), 'version = 1\n[[rules]]\npatterns = ["blocked.txt"]\nrequire = ["guide.md"]\n');
    await writeFile(join(project, "guide.md"), "conventions\n".repeat(1200));
    assert.equal((await fixture.runJson({ prompt: marker })).status, "success");
    assert.equal(existsSync(join(project, "blocked.txt")), false);
    const files = await readdir(fixture.workspace.sessionsDir);
    const resumed = await fixture.runJson({ prompt: next, sessionFile: join(fixture.workspace.sessionsDir, files[0]!) });
    assert.equal(resumed.status, "success");
    assert.deepEqual(resumed.toolExecutions.map((tool) => tool.isError), [false]);
    assert.equal(await readFile(join(project, "blocked.txt"), "utf8"), "after\n");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
}
