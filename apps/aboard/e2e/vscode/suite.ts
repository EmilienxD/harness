import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { commands, extensions, window, workspace } from "vscode";

const execFileAsync = promisify(execFile);

interface CommandEndpoint { readonly port: number; readonly workspaceRoot: string; readonly commandToken: string }
interface AboardApi { readonly commandEndpointDirectory: string }
interface Observation { readonly scenario: string | null; readonly checkpoint: string | null; readonly sessionHash: string | null; readonly model: string | null; readonly toolNamesOffered: readonly string[]; readonly result: string }
interface Diagnostics { readonly upstreamMode: string; readonly observations: readonly Observation[] }

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, message: string, attempts = 240): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
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

async function endpoint(directory: string, root: string): Promise<CommandEndpoint | undefined> {
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    const value = JSON.parse(await readFile(join(directory, entry), "utf8")) as CommandEndpoint;
    if (value.workspaceRoot === root) return value;
  }
  return undefined;
}

export async function run(): Promise<void> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.equal(root?.toLowerCase(), process.env.ABOARD_E2E_REPOSITORY_ROOT?.toLowerCase());
  if (!root) throw new Error("E2E repository workspace is not open");
  const extension = extensions.getExtension("aboard.aboard");
  assert.ok(extension, "aboard extension is discoverable");
  const api = await extension.activate() as AboardApi;
  const phase = process.env.ABOARD_E2E_PHASE;

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
    const existingTerminals = new Set(window.terminals);
    const opened: typeof window.terminals[number][] = [];
    const terminalListener = window.onDidOpenTerminal((terminal) => opened.push(terminal));
    const implementer = await eventually(async () => {
      const terminal = opened.find((candidate) => !existingTerminals.has(candidate));
      if (terminal !== undefined) return terminal;
      await commands.executeCommand("aboard.autoRun.refresh");
      await commands.executeCommand("aboard.startAutoRun");
      return undefined;
    },
      "auto-run did not launch a visible implementer terminal",
    );
    terminalListener.dispose();
    assert.ok(await implementer.processId);

    const completed = await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-review-complete") ? value : undefined;
    }, "auto-run workers did not complete", 480);
    assert.equal(completed.upstreamMode, "forbidden");
    const rows = completed.observations.filter((item) => item.scenario === "auto-run-afk" && item.result === "success");
    assert.deepEqual(rows.map((item) => item.checkpoint), [
      "auto-explore-read", "auto-explore-complete", "auto-afk-read", "auto-afk-edit", "auto-afk-complete", "auto-review-complete",
    ]);
    assert.ok(rows.find((item) => item.checkpoint === "auto-afk-read")?.toolNamesOffered.includes("Read"));
    assert.ok(rows.find((item) => item.checkpoint === "auto-afk-edit")?.toolNamesOffered.includes("Edit"));
    assert.equal(rows.some((item) => item.toolNamesOffered.some((name) => name.startsWith("mcp__aboard__"))), false);
    assert.equal(rows.every((item) => item.model?.includes("haiku") === true), true, "routine implementer, Explore, and reviewer use their configured Haiku routing");

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
      const runPullRequest = rows.find((row) => row.headRefName?.startsWith("run/") && row.baseRefName === "main");
      return issuePullRequest?.state === "MERGED" && runPullRequest?.state === "MERGED" ? { issuePullRequest, runPullRequest } : undefined;
    }, "auto-run did not merge its issue and run pull requests", 480);
    assert.ok(pullRequests.runPullRequest.headRefName?.startsWith("run/"));
    for (const pullRequest of [pullRequests.issuePullRequest, pullRequests.runPullRequest]) {
      assert.ok(pullRequest.mergeCommit?.oid, "merged pull request exposes its merge commit");
      const commit = JSON.parse((await execFileAsync("gh", ["api", `repos/${repository}/git/commits/${pullRequest.mergeCommit.oid}`], { encoding: "utf8" })).stdout) as { parents?: unknown[] };
      assert.equal(commit.parents?.length, 2, "merge strategy produces a two-parent merge commit");
    }
    await eventually(async () => {
      const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd: root, encoding: "utf8" })).stdout;
      return /^## main\.\.\.origin\/main(?: \[behind \d+\])?\s*$/u.test(status) ? status : undefined;
    }, "auto-run did not restore clean main", 480);
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "aboard e2e fixture: before\n");
    const remoteFixture = (await execFileAsync("git", ["show", "origin/main:deterministic.txt"], { cwd: root, encoding: "utf8" })).stdout;
    assert.equal(remoteFixture.replace(/\r\n/gu, "\n"), "aboard e2e fixture: after\n");
    return;
  }
  if (phase === "auto-run-single") {
    const repository = process.env.ABOARD_E2E_REPOSITORY;
    const hitl = Number(process.env.ABOARD_E2E_AUTO_RUN_HITL_ISSUE);
    const followup = Number(process.env.ABOARD_E2E_AUTO_RUN_FOLLOWUP_ISSUE);
    assert.ok(repository, "single-branch repository is configured");
    assert.ok(Number.isInteger(hitl) && hitl > 0);
    assert.ok(Number.isInteger(followup) && followup > 0);
    const opened: typeof window.terminals[number][] = [];
    const terminalListener = window.onDidOpenTerminal((terminal) => opened.push(terminal));
    await eventually(async () => {
      if (opened.length > 0) return opened[0];
      await commands.executeCommand("aboard.autoRun.refresh");
      await commands.executeCommand("aboard.startAutoRun");
      return undefined;
    }, "single-branch auto-run did not launch its first visible terminal");

    await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-hitl-complete") ? value : undefined;
    }, "single-branch HITL implementer did not complete", 480);
    const runPullRequest = await eventually(async () => {
      const rows = JSON.parse((await execFileAsync("gh", ["pr", "list", "--repo", repository, "--state", "open", "--limit", "10", "--json", "number,headRefName,baseRefName,body"], { encoding: "utf8" })).stdout) as { number?: number; headRefName?: string; baseRefName?: string; body?: string }[];
      return rows.find((row) => row.headRefName?.startsWith("run/") && row.baseRefName === "main");
    }, "single-branch run did not open its cumulative pull request", 480);
    const worktree = await eventually(async () => {
      const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).stdout;
      return worktreeRoots(output).find((path) => path.toLowerCase() !== resolve(root).toLowerCase());
    }, "single-branch run did not create its isolated checkout");
    assert.notEqual(worktree.toLowerCase(), root.toLowerCase());
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "aboard e2e fixture: before\n");

    await eventually(async () => {
      await commands.executeCommand("aboard.continueAutoRun");
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(hitl), "--repo", repository, "--json", "state"], { encoding: "utf8" })).stdout) as { state?: string };
      return issue.state === "CLOSED" ? issue : undefined;
    }, "single-branch HITL issue was not explicitly accepted", 480);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal((await diagnostics())?.observations.some((item) => item.checkpoint === "auto-followup-read"), false, "pauseAfterHitl must stop before the next issue");

    await eventually(async () => {
      await commands.executeCommand("aboard.autoRun.refresh");
      await commands.executeCommand("aboard.resumeAutoRun");
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-followup-read") ? value : undefined;
    }, "paused single-branch run did not resume its follow-up", 480);
    const completed = await eventually(async () => {
      const value = await diagnostics();
      return value?.observations.some((item) => item.checkpoint === "auto-followup-complete") ? value : undefined;
    }, "single-branch follow-up implementer did not complete", 480);
    const successes = completed.observations.filter((item) => item.result === "success");
    assert.deepEqual(successes.map((item) => item.checkpoint), [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-complete", "auto-followup-read", "auto-followup-edit", "auto-followup-complete",
    ]);
    assert.equal(new Set(successes.map((item) => item.sessionHash).filter(Boolean)).size, 2);
    assert.equal(successes.some((item) => item.toolNamesOffered.some((name) => name.startsWith("mcp__aboard__"))), false);
    assert.equal(successes.every((item) => item.model?.includes("opus") === true), true, "advanced and expert workers use their configured Opus routing");
    await eventually(async () => {
      const issue = JSON.parse((await execFileAsync("gh", ["issue", "view", String(followup), "--repo", repository, "--json", "state"], { encoding: "utf8" })).stdout) as { state?: string };
      return issue.state === "CLOSED" ? issue : undefined;
    }, "single-branch follow-up issue did not close", 480);
    const pullRequest = await eventually(async () => {
      const value = JSON.parse((await execFileAsync("gh", ["pr", "view", String(runPullRequest.number), "--repo", repository, "--json", "state,body"], { encoding: "utf8" })).stdout) as { state?: string; body?: string };
      return new RegExp(`#${hitl}.*#${followup}`, "s").test(value.body ?? "") ? value : undefined;
    }, "cumulative pull request did not include both accepted issues", 480);
    assert.equal(pullRequest.state, "OPEN");
    await eventually(async () => {
      const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).stdout;
      return worktreeRoots(output).some((path) => path.toLowerCase() === worktree.toLowerCase()) ? undefined : true;
    }, "drained single-branch run did not remove its isolated checkout", 480);
    assert.equal(await readFile(join(root, "deterministic.txt"), "utf8"), "aboard e2e fixture: before\n");
    const status = (await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], { cwd: root, encoding: "utf8" })).stdout;
    assert.match(status, /^## main\.\.\.origin\/main\s*$/u);
    assert.ok(opened.length >= 2, "both single-branch implementers launched in visible terminals");
    terminalListener.dispose();
    return;
  }
  if (phase !== "admission") throw new Error(`Unknown extension E2E phase ${String(phase)}`);
  const published = await eventually(() => endpoint(api.commandEndpointDirectory, root), "initialized project did not publish the command endpoint");
  assert.equal(window.terminals.some((terminal) => terminal.name.startsWith("aboard:")), false);
  await assert.rejects(access(join(root, ".abd", "agents")));

  await rm(join(root, ".abd"), { recursive: true, force: true });
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
