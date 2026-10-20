import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import type { PiRun } from "../../core/pi.js";
import { startDiscordFixture } from "./discord.js";
import { LONG_REPORT, REPORT, marker, scenario } from "./scenario.js";

const execFileAsync = promisify(execFile);
const TOOL = "report-gotchas";
const details = (run: PiRun) => run.events.filter(e => e.type === "tool_execution_end" && e.toolName === "report_gotchas").map(e => (e.result as { details?: { receipt: string; duplicate: boolean; configured: boolean } }).details);
async function files(root: string) { try { return (await readdir(root)).filter(f => f.endsWith(".json")); } catch { return []; } }
async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Pi gotcha fixture timed out: ${label}`);
}

/** Detached delivery belongs to this fixture only when argv contains one of its own receipts. */
async function stopFixtureWorkers(root: string) {
  const receipts = (await files(join(root, "gotchas-state", "pi", "submitted"))).map(file => file.slice(0, -5)).filter(value => /^[0-9a-f]{32}$/u.test(value));
  if (!receipts.length) return;
  if (process.platform === "win32") {
    const script = '$receipts = @([Console]::In.ReadToEnd() | ConvertFrom-Json); Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine -match "(?:^|\\s)-m\\s+report_gotchas\\.cli\\s+deliver\\s+([0-9a-f]{32})(?:\\s|$)" -and $receipts -contains $Matches[1]) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }';
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Gotcha worker teardown timed out")); }, 10_000);
      child.on("error", () => { clearTimeout(timer); reject(new Error("Gotcha worker teardown could not start")); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Gotcha worker teardown failed")); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(receipts));
    });
  } else {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+.*(?:^|\s)-m\s+report_gotchas\.cli\s+deliver\s+([0-9a-f]{32})(?:\s|$)/u.exec(line);
      if (match && receipts.includes(match[2]!)) { try { process.kill(Number(match[1]), "SIGKILL"); } catch { /* already exited */ } }
    }
  }
}

export async function runPiGotchasJourney(scope: "project" | "user", mode: "json" | "rpc") {
  const fixture = await createPiFixture(scenario);
  let discord: Awaited<ReturnType<typeof startDiscordFixture>> | undefined;
  try {
    discord = await startDiscordFixture(fixture.root);
    const project = fixture.workspace.projectRoot;
    const root = await findHarnessRoot();
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    Object.assign(fixture.workspace.env, {
      UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      UV_PYTHON: join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1", HARNESS_REPORT_GOTCHAS_STATE_DIR: join(fixture.root, "gotchas-state"),
    });
    // Neither personal webhooks nor model credentials enter this isolated process environment.
    const state = fixture.workspace.env.HARNESS_REPORT_GOTCHAS_STATE_DIR!;
    const queue = join(state, "pi", "queue");
    const submitted = join(state, "pi", "submitted");
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const skill = join(platform, "skills", TOOL, "SKILL.md");
    const settings = await readFile(join(project, ".pi", "settings.json"), "utf8");
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope, dryRun: true });
    await assert.rejects(access(skill));
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    const repeat = await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    assert.equal((repeat.results as { status: string }[]).find(result => result.status !== "unchanged"), undefined);
    Object.assign(fixture.workspace.env, discord.env);
    assert.equal(await readFile(skill, "utf8"), await readFile(join(root, "harness", "productivity", TOOL, "SKILL.md"), "utf8"));
    await assert.rejects(access(join(platform, "skills", TOOL, "chatgpt")));
    const probe = join(project, ".pi", "extensions", "gotchas-probe");
    await mkdir(probe, { recursive: true });
    await copyFile(join(root, "tests", "e2e", "tools", "pi-report-gotchas", "probe.ts.txt"), join(probe, "index.ts"));
    const git = async (...args: string[]) => execFileAsync("git", args, { cwd: project, env: fixture.workspace.env, windowsHide: true, timeout: 10_000 });
    await git("init", "-b", "main");
    await git("config", "user.name", "Harness fixture"); await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(project, "tracked.txt"), "baseline\n"); await git("add", "tracked.txt"); await git("commit", "-qm", "Fixture baseline");
    await writeFile(join(project, "tracked.txt"), "changed\n");
    const sessionId = randomUUID();
    let rpc = fixture.rpc({ sessionId, timeoutMs: 180_000 });
    const commands = (await rpc.request("get_commands")).data as { commands: { name: string; source: string }[] };
    assert.ok(commands.commands.some(c => c.name === `skill:${TOOL}` && c.source === "skill"));
    assert.equal((await rpc.prompt("/gotchas-anchor")).status, "handled");
    assert.equal((await rpc.prompt(marker("none"))).status, "success");
    const saved = (await readdir(fixture.workspace.sessionsDir)).find(file => file.endsWith(`_${sessionId}.jsonl`))!;
    assert.ok(saved);
    const sessionFile = join(fixture.workspace.sessionsDir, saved);
    if (mode === "json") await rpc.close();
    const prompt = `/skill:report-gotchas ${marker("submit")}`;
    const first = mode === "rpc" ? await rpc.prompt(prompt) : await fixture.runJson({ prompt, sessionFile });
    assert.equal(first.status, "success");
    assert.deepEqual(details(first).map(d => d?.duplicate), [false, true]);
    const receipt = details(first)[0]!.receipt;
    const queued = JSON.parse(await readFile(join(queue, receipt + ".json"), "utf8"));
    assert.equal(queued.provider, "pi"); assert.equal(queued.session_id, sessionId); assert.equal(queued.cwd, project);
    assert.equal(queued.message, REPORT); assert.equal(queued.git.branch, "main"); assert.ok(queued.git.status.includes("tracked.txt"));
    assert.equal((await files(submitted)).length, 1); assert.equal(discord.attempts, 0);
    if (mode === "json") {
      rpc = fixture.rpc({ timeoutMs: 180_000 });
      assert.equal((await rpc.request("switch_session", { sessionPath: sessionFile })).success, true);
    }
    assert.equal((await rpc.prompt("/report-gotchas-retry")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    // Exercise the real host configuration CLI. It shares config but cannot race Pi's queue.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(join(bin, process.platform === "win32" ? "harness-report-gotchas.exe" : "harness-report-gotchas"), ["configure"],
        { cwd: project, env: fixture.workspace.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Gotcha fixture configuration timed out")); }, 10_000);
      child.on("error", () => { clearTimeout(timer); reject(new Error("Gotcha fixture configuration could not start")); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Gotcha fixture configuration failed")); });
      child.stdin.on("error", () => {});
      child.stdin.end(discord!.url);
    });
    assert.equal((await files(join(state, "queue"))).length, 0);
    assert.equal((await files(queue)).length, 1);
    discord.rateLimitOnce();
    await rpc.prompt("/report-gotchas-retry");
    await waitFor(async () => (await files(queue)).length === 0, "initial delivery");
    assert.equal(discord.accepted.length, 1); assert.equal(discord.rateLimits, 1);
    assert.ok(discord.accepted[0]!.content.includes(`**Pi:** ${sessionId}`));
    assert.ok(discord.accepted[0]!.content.endsWith(REPORT));
    assert.deepEqual(discord.accepted[0]!.allowed_mentions, { parse: [] });
    await rpc.close();
    const resumed = await fixture.runJson({ prompt: marker("submit"), sessionFile });
    assert.equal(resumed.status, "success"); assert.deepEqual(details(resumed).map(d => d?.duplicate), [true, true]);
    assert.equal(discord.accepted.length, 1);
    const next = fixture.rpc({ sessionId, timeoutMs: 180_000 });
    assert.equal((await next.request("switch_session", { sessionPath: sessionFile })).success, true);
    await next.prompt("/gotchas-reload");
    assert.equal((await next.prompt(marker("submit"))).status, "success");
    await next.prompt("/gotchas-back");
    assert.equal((await next.prompt(marker("submit"))).status, "success");
    assert.equal(discord.accepted.length, 1); assert.equal((await files(submitted)).length, 1);
    const beforeEmpty = (await files(submitted)).length;
    const empty = await next.prompt(marker("empty"));
    assert.equal(empty.status, "success"); assert.equal(empty.toolExecutions[0]?.isError, true);
    assert.equal((await files(submitted)).length, beforeEmpty);
    const helper = join(platform, "harness", "report_gotchas_pi.py");
    await rename(helper, helper + ".off");
    const unavailable = await next.prompt(marker("long"));
    assert.equal(unavailable.status, "success"); assert.equal(unavailable.toolExecutions[0]?.isError, true);
    assert.equal((await files(submitted)).length, beforeEmpty);
    await rename(helper + ".off", helper);
    const nested = await next.prompt(marker("nested")); assert.equal(nested.status, "success");
    const evidence = JSON.parse(await readFile(join(project, "nested-evidence.json"), "utf8")) as { receipt: string; duplicate: boolean }[];
    assert.equal(evidence[0]!.receipt, evidence[1]!.receipt);
    assert.deepEqual(evidence.map(e => e.duplicate).sort(), [false, true]);
    await waitFor(async () => (await files(queue)).length === 0, "nested delivery");
    assert.equal(discord.accepted.length, 2);
    discord.failAfter(3);
    const partial = await next.prompt(marker("long")); assert.equal(partial.status, "success");
    const longReceipt = details(partial)[0]!.receipt;
    await waitFor(async () => {
      const value = JSON.parse(await readFile(join(queue, longReceipt + ".json"), "utf8"));
      return value.next_message === 1 && discord!.attempts >= 5;
    }, "partial delivery checkpoint");
    assert.equal(discord.accepted.length, 3);
    const duplicatePartial = await next.prompt(marker("long"));
    assert.equal(details(duplicatePartial)[0]?.duplicate, true);
    assert.equal(details(duplicatePartial)[0]?.receipt, longReceipt);
    assert.equal(JSON.parse(await readFile(join(queue, longReceipt + ".json"), "utf8")).next_message, 1);
    discord.recover();
    const requestsBeforeRetry = fixture.assertions().inferenceRequests;
    await next.prompt("/report-gotchas-retry invalid");
    await next.prompt("/report-gotchas-retry");
    await waitFor(async () => (await files(queue)).length === 0, "multipart retry");
    assert.equal(fixture.assertions().inferenceRequests, requestsBeforeRetry);
    const parts = discord.accepted.slice(2);
    assert.ok(parts.length >= 3);
    assert.equal(parts.filter(p => p.content.includes("**Pi:**")).length, 1);
    assert.ok(parts.map(p => p.content).join("\n").includes("Partial delivery recovery"));
    assert.ok(parts.every(p => Buffer.byteLength(p.content, "utf16le") / 2 <= 2000));
    const beforeFork = discord.accepted.length;
    await next.prompt("/gotchas-fork");
    assert.equal((await next.prompt(marker("submit"))).status, "success");
    await waitFor(async () => (await files(queue)).length === 0, "fork delivery");
    assert.equal(discord.accepted.length, beforeFork + 1);
    assert.equal((await next.request("new_session")).success, true);
    assert.equal((await next.prompt(marker("submit"))).status, "success");
    await waitFor(async () => (await files(queue)).length === 0, "new-session delivery");
    assert.equal(discord.accepted.length, beforeFork + 2);
    assert.equal((await files(submitted)).length, 5);
    const beforeNone = discord.accepted.length;
    assert.equal((await next.prompt(marker("none"))).status, "success");
    assert.equal(discord.accepted.length, beforeNone);
    await next.close();
    await runFixtureInstaller(fixture.workspace, "uninstall", [TOOL], { scope });
    await assert.rejects(access(skill)); await assert.rejects(access(helper));
    await assert.rejects(access(join(platform, "extensions", ".harness-report-gotchas", "index.ts")));
    await assert.rejects(access(join(platform, "harness", "pi-transport", "transport.ts")));
    await assert.rejects(access(join(bin, process.platform === "win32" ? "harness-report-gotchas.exe" : "harness-report-gotchas")));
    assert.equal((await files(submitted)).length, 5);
    assert.equal(await readFile(join(project, ".pi", "settings.json"), "utf8"), settings);
    assert.equal(discord.unexpected, 0); assert.equal(fixture.assertions().unexpectedRequests, 0);
    assert.equal(fixture.assertions().inferenceRequests, 30);
    return { scope, mode, version: fixture.version, inferenceRequests: fixture.assertions().inferenceRequests,
      submissions: 5, deliveredParts: discord.accepted.length, rateLimits: discord.rateLimits, recoveredMultipart: LONG_REPORT.length > 2000 };
  } finally {
    try { await stopFixtureWorkers(fixture.root); }
    finally { try { await discord?.close(); } finally { await fixture.close(); } }
  }
}
