import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { commands, extensions, window, workspace } from "vscode";

import { isTransientObservationError, removeDirectoryWithRetries } from "./support.js";

const execFileAsync = promisify(execFile);

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string }
interface AboardApi { readonly commandEndpointDirectory: string }
interface Observation { readonly scenario: string | null; readonly checkpoint: string | null; readonly sessionHash: string | null; readonly model: string | null; readonly toolNamesOffered: readonly string[]; readonly result: string }
interface Diagnostics { readonly upstreamMode: string; readonly observations: readonly Observation[] }

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, message: string, attempts = 240): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      // Observation callbacks only read state; never replay a mutation here.
      if (!isTransientObservationError(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function diagnostics(): Promise<Diagnostics | undefined> {
  const path = process.env.ABOARD_E2E_DIAGNOSTICS;
  assert.ok(path, "diagnostics path is configured");
  try { return JSON.parse(await readFile(path, "utf8")) as Diagnostics; }
  catch { return undefined; }
}

async function submitHitlAcceptance(cwd: string): Promise<void> {
  // The fixture acts as the user accepting the handed-off worker's unstaged edits.
  await execFileAsync("git", ["add", "--", "deterministic.txt"], { cwd, windowsHide: true });
  await execFileAsync("git", ["-c", "commit.gpgSign=false", "commit", "-m", "Accept deterministic worker change"], { cwd, windowsHide: true });
}

async function endpoint(directory: string, root: string): Promise<CommandEndpoint | undefined> {
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    const value = JSON.parse(await readFile(join(directory, entry), "utf8")) as CommandEndpoint;
    if (value.workspaceRoot === root) return value;
  }
  return undefined;
}

async function startAutoRunWithFixtureConsent(): Promise<void> {
  // The fixture acts as the user approving its own isolated Codex hooks. Every
  // provider tool, lifecycle hook, guard and visible terminal remains real.
  const original = window.showWarningMessage;
  let refusal: string | undefined;
  window.showWarningMessage = ((message: string, ...options: unknown[]) => {
    if (options.includes("Allow Hooks")) return Promise.resolve("Allow Hooks");
    if (message.startsWith("aboard cannot start an auto-run:")) { refusal = message; return Promise.resolve(undefined); }
    return Reflect.apply(original, window, [message, ...options]);
  }) as typeof original;
  try {
    await commands.executeCommand("aboard.startAutoRun");
    if (refusal) throw new Error(refusal);
  }
  finally { window.showWarningMessage = original; }
}

export async function run(): Promise<void> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(root?.toLowerCase(), process.env.ABOARD_E2E_REPOSITORY_ROOT?.toLowerCase());
  if (!root) throw new Error("E2E repository workspace is not open");
  const extension = extensions.getExtension("aboard.aboard");
  assert.ok(extension, "aboard extension is discoverable");
  const api = await extension.activate() as AboardApi;
  const phase = process.env.ABOARD_E2E_PHASE;
  const platform = process.env.ABOARD_E2E_PLATFORM ?? "claude";

  if (phase === "initialize") {
    assert.equal(window.terminals.some((terminal) => terminal.name.startsWith("aboard:")), false);
    assert.equal(await endpoint(api.commandEndpointDirectory, root), undefined);
    await commands.executeCommand("aboard.initializeProject");
    const published = await eventually(() => endpoint(api.commandEndpointDirectory, root), "initialization did not publish the command endpoint");
    assert.ok(published.port > 0);
    await assert.rejects(access(join(root, ".abd", "agents")));
    await assert.rejects(access(join(root, ".claude")));
    await assert.rejects(access(join(root, ".mcp.json")));
    await assert.rejects(access(join(root, ".gitignore")));
    return;
  }
  if (phase === "auto-run") {
    const repository = process.env.ABOARD_E2E_REPOSITORY;
    const issueNumber = Number(process.env.ABOARD_E2E_AUTO_RUN_ISSUE);
    const contextIssues = (process.env.ABOARD_E2E_AUTO_RUN_CONTEXT_ISSUES ?? "").split(",").map(Number);
    assert.ok(repository, "auto-run repository is configured");
    assert.ok(Number.isInteger(issueNumber) && issueNumber > 0, "auto-run issue number is configured");
    assert.equal(contextIssues.length, 2);
    assert.ok(contextIssues.every((number) => Number.isInteger(number) && number > 0));
    const opened: typeof window.terminals[number][] = [];
    const terminalListener = window.onDidOpenTerminal((terminal) => opened.push(terminal));
    await commands.executeCommand("aboard.autoRun.refresh");
    await startAutoRunWithFixtureConsent();
    const implementer = await eventually(
      () => opened.find((terminal) => "env" in terminal.creationOptions && terminal.creationOptions.env?.ABOARD_AGENT_ID),
      "auto-run did not launch a visible implementer terminal",
    );
    assert.ok(await implementer.processId);

    const completed = await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-review-complete") ? value : undefined;
    }, "auto-run workers did not complete", 480);
    terminalListener.dispose();
    const workerTerminals = opened.filter((terminal) => "env" in terminal.creationOptions && terminal.creationOptions.env?.ABOARD_AGENT_ID);
    assert.equal(workerTerminals.length, 2, "the implementer and the reviewer each ran in a visible terminal");
    assert.equal(workerTerminals.some((terminal) => "env" in terminal.creationOptions && terminal.creationOptions.env?.ABOARD_AGENT_TYPE === "explore"), false, "exploration runs headless without a terminal");
    assert.equal(completed.upstreamMode, "forbidden");
    const rows = completed.observations.filter((item) => item.scenario === "auto-run-afk" && item.result === "success" && item.checkpoint !== "auto-tool-wait");
    assert.deepEqual(rows.map((item) => item.checkpoint), [
      "auto-explore-read", "auto-explore-complete", "auto-afk-read", "auto-afk-edit", "auto-afk-commit", "auto-afk-complete", "auto-review-commit", "auto-review-complete",
    ]);
    const expectedTool = platform === "pi" ? "read" : platform === "chatgpt" ? "exec" : "Read";
    assert.ok(rows.find((item) => item.checkpoint === "auto-afk-read")?.toolNamesOffered.includes(expectedTool));
    assert.ok(rows.find((item) => item.checkpoint === "auto-afk-edit")?.toolNamesOffered.includes(platform === "pi" ? "edit" : platform === "chatgpt" ? "exec" : "Edit"));
    assert.equal(rows.some((item) => item.toolNamesOffered.some((name) => name.startsWith("mcp__aboard__"))), false);
    assert.equal(rows.every((item) => platform === "pi" ? item.model === "pi-e2e" : platform === "chatgpt" ? item.model === "codex-e2e" || item.model?.includes("luna") === true : item.model?.includes("haiku") === true), true, `routine workers use their configured ${platform} routing`);

    await eventually(async () => {
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(issueNumber), "--repo", repository, "--json", "state"], { encoding: "utf8" })).stdout) as { state?: string };
      return issue.state === "CLOSED" ? issue : undefined;
    }, "auto-run did not close its landed issue", 480);
    for (const number of contextIssues) {
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(number), "--repo", repository, "--json", "state,labels"], { encoding: "utf8" })).stdout) as { state?: string; labels?: { name?: string }[] };
      assert.equal(issue.state, "OPEN", `unclassified context issue #${number} remains outside the run`);
      assert.deepEqual(issue.labels, []);
    }
    const pullRequests = await eventually(async () => {
      const rows = JSON.parse((await execFileAsync("gh", ["pr", "list", "--repo", repository, "--state", "all", "--limit", "20", "--json", "number,state,headRefName,baseRefName,body,mergeCommit"], { encoding: "utf8" })).stdout) as { state?: string; headRefName?: string; baseRefName?: string; body?: string; mergeCommit?: { oid?: string } }[];
      const issuePullRequest = rows.find((row) => row.body?.includes(`Closes #${issueNumber}`));
      const runPullRequest = rows.find((row) => row.headRefName === issuePullRequest?.baseRefName && row.baseRefName === "main");
      return issuePullRequest?.state === "MERGED" && runPullRequest?.state === "MERGED" ? { issuePullRequest, runPullRequest } : undefined;
    }, "auto-run did not merge its issue and run pull requests", 480);
    assert.ok(pullRequests.runPullRequest.headRefName?.startsWith("abd/"));
    for (const pullRequest of [pullRequests.issuePullRequest, pullRequests.runPullRequest]) {
      assert.ok(pullRequest.mergeCommit?.oid, "merged pull request exposes its merge commit");
      const commit = JSON.parse((await execFileAsync("gh", ["api", `repos/${repository}/git/commits/${pullRequest.mergeCommit.oid}`], { encoding: "utf8" })).stdout) as { parents?: unknown[] };
      assert.equal(commit.parents?.length, 2, "merge strategy produces a two-parent merge commit");
    }
    await eventually(async () => {
      const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd: root, encoding: "utf8" })).stdout;
      return /^## main\.\.\.origin\/main(?: \[behind \d+\])?\s*$/u.test(status) ? status : undefined;
    }, "auto-run did not restore clean main", 480);
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "harness e2e fixture: before\n");
    await execFileAsync("git", ["fetch", "origin", "main"], { cwd: root, encoding: "utf8", windowsHide: true });
    const remoteFixture = (await execFileAsync("git", ["show", "origin/main:deterministic.txt"], { cwd: root, encoding: "utf8" })).stdout;
    assert.equal(remoteFixture.replace(/\r\n/gu, "\n"), "harness e2e fixture: after\n");
    return;
  }
  if (phase === "auto-run-single") {
    const repository = process.env.ABOARD_E2E_REPOSITORY;
    const hitl = Number(process.env.ABOARD_E2E_AUTO_RUN_HITL_ISSUE);
    const followup = Number(process.env.ABOARD_E2E_AUTO_RUN_FOLLOWUP_ISSUE);
    const review = process.env.ABOARD_E2E_AUTO_RUN_REVIEW === "true";
    assert.ok(repository, "HITL repository is configured");
    assert.ok(Number.isInteger(hitl) && hitl > 0);
    if (review) assert.equal(Number.isNaN(followup), true);
    else assert.ok(Number.isInteger(followup) && followup > 0);
    const opened: typeof window.terminals[number][] = [];
    const terminalListener = window.onDidOpenTerminal((terminal) => opened.push(terminal));
    await commands.executeCommand("aboard.autoRun.refresh");
    await startAutoRunWithFixtureConsent();
    await eventually(() => opened[0], "HITL auto-run did not launch its first visible terminal");

    const handoffCheckpoint = review ? "auto-hitl-review-complete" : "auto-hitl-handoff";
    await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === handoffCheckpoint) ? value : undefined;
    }, review ? "HITL review did not complete" : "HITL address did not complete", 960);
    const worktree = await eventually(async () => {
      const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).stdout;
      return worktreeRoots(output).find((path) => path.toLowerCase() !== resolve(root).toLowerCase());
    }, "HITL run did not create its isolated checkout");
    assert.notEqual(worktree.toLowerCase(), root.toLowerCase());
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "harness e2e fixture: before\n");
    for (const terminal of opened) {
      const cwd = "cwd" in terminal.creationOptions ? terminal.creationOptions.cwd : undefined;
      assert.equal(typeof cwd === "string" ? resolve(cwd).toLowerCase() : cwd?.fsPath.toLowerCase(), resolve(worktree).toLowerCase());
    }

    // The user is expected to be able to talk to the worker they must accept,
    // and closing that terminal before acceptance stops the run instead.
    const handoffTerminal = review ? opened[1] : opened[0];
    assert.ok(handoffTerminal && window.terminals.includes(handoffTerminal), "HITL keeps its handoff terminal visible");
    const dirty = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: worktree, encoding: "utf8" })).stdout;
    assert.match(dirty, /^ M deterministic\.txt\s*$/u, "the acceptance handoff is wholly unstaged");
    const rootHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
    const handoffHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" })).stdout.trim();
    assert.equal(handoffHead, rootHead, "the temporary address checkpoint is reset before acceptance");
    const beforeAcceptance = (await execFileAsync("gh", ["pr", "list", "--repo", repository, "--state", "open", "--json", "number"], { encoding: "utf8" })).stdout;
    assert.deepEqual(JSON.parse(beforeAcceptance), [], "no PR exists before acceptance");
    // Let the handoff settle so acceptance models a deliberate user follow-up
    // instead of racing the worker's own task settlement.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await submitHitlAcceptance(worktree);

    await eventually(async () => {
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(hitl), "--repo", repository, "--json", "state"], { encoding: "utf8" })).stdout) as { state?: string };
      return issue.state === "CLOSED" ? issue : undefined;
    }, "HITL acceptance commit did not advance Auto Run", 480);
    const runPullRequest = await eventually(async () => {
      const rows = JSON.parse((await execFileAsync("gh", ["pr", "list", "--repo", repository, "--state", "open", "--limit", "10", "--json", "number,headRefName,baseRefName,body"], { encoding: "utf8" })).stdout) as { number?: number; headRefName?: string; baseRefName?: string; body?: string }[];
      return rows.find((row) => row.headRefName?.startsWith("abd/") && row.baseRefName === "main");
    }, "HITL run did not open its cumulative pull request", 480);
    if (!review) await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-followup-read") ? value : undefined;
    }, "HITL run did not start its follow-up automatically", 480);
    const finalCheckpoint = review ? "auto-hitl-review-complete" : "auto-followup-complete";
    const completed = await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === finalCheckpoint) ? value : undefined;
    }, review ? "HITL acceptance conversation did not complete" : "HITL follow-up address did not complete", 480);
    const successes = completed.observations.filter((item) => item.scenario !== null && item.scenario !== "task" && item.result === "success" && item.checkpoint !== "auto-tool-wait");
    assert.deepEqual(successes.map((item) => item.checkpoint), review ? [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-commit", "auto-hitl-complete",
      "auto-hitl-review-read", "auto-hitl-review-complete",
    ] : [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-handoff",
      "auto-followup-read", "auto-followup-edit", "auto-followup-commit", "auto-followup-complete",
    ]);
    if (platform !== "pi") assert.equal(new Set(successes.map((item) => item.sessionHash).filter(Boolean)).size, 2);
    else assert.equal(new Set(opened.filter((terminal) => "env" in terminal.creationOptions).map((terminal) => "env" in terminal.creationOptions ? terminal.creationOptions.env?.ABOARD_SESSION_ID : undefined).filter(Boolean)).size, 2);
    assert.equal(successes.some((item) => item.toolNamesOffered.some((name) => name.startsWith("mcp__aboard__"))), false);
    assert.equal(successes.every((item) => platform === "pi" ? item.model === "pi-e2e" : item.model?.includes(platform === "chatgpt" ? "sol" : "opus") === true), true, `advanced and expert workers use their configured ${platform} routing`);
    if (!review) await eventually(async () => {
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(followup), "--repo", repository, "--json", "state"], { encoding: "utf8" })).stdout) as { state?: string };
      return issue.state === "CLOSED" ? issue : undefined;
    }, "HITL follow-up issue did not close", 480);
    const pullRequest = await eventually(async () => {
      const value = JSON.parse((await execFileAsync("gh", ["pr", "view", String(runPullRequest.number), "--repo", repository, "--json", "state,body"], { encoding: "utf8" })).stdout) as { state?: string; body?: string };
      const expectedIssues = review ? new RegExp(`#${hitl}`, "s") : new RegExp(`#${hitl}.*#${followup}`, "s");
      return expectedIssues.test(value.body ?? "") ? value : undefined;
    }, "cumulative pull request did not include the accepted issues", 480);
    assert.equal(pullRequest.state, "OPEN");
    await eventually(async () => {
      const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).stdout;
      return worktreeRoots(output).some((path) => path.toLowerCase() === worktree.toLowerCase()) ? undefined : true;
    }, "drained HITL run did not remove its isolated checkout", 480);
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "harness e2e fixture: before\n");
    const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd: root, encoding: "utf8" })).stdout;
    assert.match(status, /^## main\.\.\.origin\/main\s*$/u);
    assert.ok(opened.length >= 2, review ? "the implementer and reviewer launched in visible terminals" : "both HITL run implementers launched in visible terminals");
    terminalListener.dispose();
    return;
  }
  if (phase !== "admission") throw new Error(`Unknown extension E2E phase ${String(phase)}`);
  const published = await eventually(() => endpoint(api.commandEndpointDirectory, root), "initialized project did not publish the command endpoint");
  assert.equal(window.terminals.some((terminal) => terminal.name.startsWith("aboard:")), false);
  await assert.rejects(access(join(root, ".abd", "agents")));

  await removeDirectoryWithRetries(join(root, ".abd"));
  await eventually(async () => await endpoint(api.commandEndpointDirectory, root) === undefined ? true : undefined, "deleting .abd did not remove the command endpoint");
  await assert.rejects(fetch(`http://127.0.0.1:${published.port}/commands`));
  const finalStatus = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" })).stdout;
  assert.equal(finalStatus, "");
}

function worktreeRoots(output: string): string[] {
  return output.split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
}
