import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runTests } from "@vscode/test-electron";

import { loadConfig } from "../config.js";
import { AUTO_RUN_AFK_MARKER, AUTO_RUN_FOLLOWUP_MARKER, AUTO_RUN_HITL_MARKER, AUTO_RUN_NESTED_CONTEXT, AUTO_RUN_PERMANENT_NOTE } from "../scenario.js";
import { startFakeAnthropicServer } from "../server.js";
import { childEnvironment, validateClaudeCli } from "../smoke.js";
import { prepareInteractiveClaudeConfig, testExecutable } from "./support.js";

const execFileAsync = promisify(execFile);

export async function runAutoRunJourney(): Promise<void> {
  const config = loadConfig();
  await validateClaudeCli();
  await resetHarness();
  await clearTestAutoRunRecords();
  await mkdir(config.claudeConfigRoot, { recursive: true });
  await prepareInteractiveClaudeConfig(config.claudeConfigRoot, [config.cloneRoot, resolve(__dirname, "..", "..", "..")]);
  await installHarnessWorkerSkills(config.claudeConfigRoot);
  const issues = await createIssues(config.repository);
  const server = await startFakeAnthropicServer({
    repoRoot: config.cloneRoot,
    diagnosticsPath: config.diagnosticsPath,
    readinessPath: config.readinessPath,
  });
  try {
    const environment = childEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config.claudeConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "aboard-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
      ABOARD_E2E_DIAGNOSTICS: config.diagnosticsPath,
      ABOARD_E2E_REPOSITORY: config.repository,
      ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot,
      ABOARD_E2E_AUTO_RUN_ISSUE: String(issues.primary),
      ABOARD_E2E_AUTO_RUN_CONTEXT_ISSUES: `${issues.context},${issues.nested}`,
    });
    const executable = await testExecutable();
    for (const phase of ["initialize", "auto-run"]) {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: resolve(__dirname, "..", "..", ".."),
        extensionTestsPath: resolve(__dirname, "suite.js"),
        extensionTestsEnv: { ...environment, ABOARD_E2E_PHASE: phase },
        launchArgs: [config.cloneRoot, "--disable-extensions"],
      });
      if (phase === "initialize") await commitInitializedScaffold(config.cloneRoot, {
        "aboard.autoRun.review": true,
        "aboard.autoRun.exploreBeforeImplement": true,
        "aboard.autoRun.issueContextDepth": 2,
        "aboard.autoRun.prompt": AUTO_RUN_PERMANENT_NOTE,
        "aboard.autoRun.mergeStrategy": "merge",
        "aboard.autoRun.mergeRunPullRequest": true,
      });
    }
    const assertions = server.assertions();
    for (const checkpoint of ["auto-explore-read", "auto-explore-complete", "auto-afk-read", "auto-afk-edit", "auto-afk-commit", "auto-afk-complete", "auto-review-complete"]) {
      if (!assertions.checkpoints.includes(checkpoint)) throw new Error(`Auto-run journey did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 7 || assertions.unexpectedRequests !== 0) {
      throw new Error(`Unexpected auto-run inference activity: ${assertions.inferenceRequests} inference requests, ${assertions.unexpectedRequests} rejected requests`);
    }
  } finally {
    await server.close();
    await resetHarness();
  }
}

async function commitInitializedScaffold(root: string, settings: Readonly<Record<string, unknown>>): Promise<void> {
  const launchPath = join(root, ".abd", "launch.json");
  const launch = JSON.parse(await readFile(launchPath, "utf8")) as Record<string, unknown>;
  launch.command = ["claude", "--permission-mode", "acceptEdits"];
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`, "utf8");
  const settingsPath = join(root, ".vscode", "settings.json");
  await mkdir(join(root, ".vscode"), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  if (settings["aboard.autoRun.worktree.enabled"] === true) await installWorktreeTrustSetup(root);
  const hooks = join(root, ".git", "e2e-empty-hooks");
  await mkdir(hooks, { recursive: true });
  await execFileAsync("git", ["add", "--", ".abd", ".vscode/settings.json"], { cwd: root, encoding: "utf8", windowsHide: true });
  await execFileAsync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "commit", "--message", "Initialize aboard E2E fixture"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "aboard e2e",
      GIT_AUTHOR_EMAIL: "aboard-e2e@invalid.example",
      GIT_COMMITTER_NAME: "aboard e2e",
      GIT_COMMITTER_EMAIL: "aboard-e2e@invalid.example",
      GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
    },
  });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: root, encoding: "utf8", windowsHide: true });
}

async function installHarnessWorkerSkills(configRoot: string): Promise<void> {
  const harnessRoot = resolve(__dirname, "..", "..", "..", "..", "..");
  for (const name of ["address-issue", "issue-review"]) {
    const destination = join(configRoot, "skills", name, "SKILL.md");
    await mkdir(join(configRoot, "skills", name), { recursive: true });
    await copyFile(join(harnessRoot, "harness", name, "shared", "skills", name, "SKILL.md"), destination);
  }
}

async function installWorktreeTrustSetup(root: string): Promise<void> {
  const script = [
    "$configPath = Join-Path $env:CLAUDE_CONFIG_DIR '.claude.json'",
    "$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json",
    "$trustedPath = [IO.Path]::GetFullPath($PWD.Path).Replace('\\', '/')",
    "$trust = [ordered]@{ allowedTools = @(); mcpContextUris = @(); mcpServers = @{}; enabledMcpjsonServers = @(); disabledMcpjsonServers = @(); hasTrustDialogAccepted = $true; hasClaudeMdExternalIncludesApproved = $false; hasClaudeMdExternalIncludesWarningShown = $false }",
    "$config.projects | Add-Member -NotePropertyName $trustedPath -NotePropertyValue $trust -Force",
    "$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding utf8",
    "",
  ].join("\n");
  await writeFile(join(root, ".abd", "session-setup.ps1"), script, "utf8");
}

async function resetHarness(): Promise<void> {
  await execFileAsync(process.execPath, [resolve(__dirname, "..", "cli.js"), "reset"], {
    cwd: resolve(__dirname, "..", "..", ".."),
    encoding: "utf8",
    windowsHide: true,
  });
}

async function clearTestAutoRunRecords(): Promise<void> {
  const storage = resolve(__dirname, "..", "..", "..", ".vscode-test", "user-data", "User", "workspaceStorage");
  const entries = await readdir(storage, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{32}$/u.test(entry.name)) continue;
    await rm(join(storage, entry.name, "aboard.aboard", "runtime", "state", "auto-run.json"), { force: true });
  }
}

async function createIssues(repository: string): Promise<{ readonly primary: number; readonly context: number; readonly nested: number }> {
  const nested = await createIssue(repository, "Nested auto-run context", AUTO_RUN_NESTED_CONTEXT, []);
  const context = await createIssue(repository, "Direct auto-run context", `Direct context references nested issue #${nested}.`, []);
  const primary = await createIssue(
    repository,
    "Deterministic auto-run fixture",
    `${AUTO_RUN_AFK_MARKER}\n\nChange deterministic.txt from the canonical before marker to the canonical after marker. Related context: #${context}.`,
    ["[AI]-afk", "[AI]-routine-difficulty"],
  );
  return { primary, context, nested };
}

async function createIssue(repository: string, title: string, body: string, labels: readonly string[]): Promise<number> {
  const result = await execFileAsync("gh", [
    "issue", "create", "--repo", repository,
    "--title", title,
    "--body", body,
    ...labels.flatMap((label) => ["--label", label]),
  ], { encoding: "utf8", windowsHide: true });
  const match = /\/issues\/(\d+)\s*$/u.exec(result.stdout.trim());
  if (!match) throw new Error("GitHub did not return the created auto-run issue number");
  return Number(match[1]);
}

async function runSingleBranchJourney(): Promise<void> {
  const config = loadConfig();
  await resetHarness();
  await clearTestAutoRunRecords();
  const hitl = await createIssue(config.repository, "Accept deterministic single-branch change", `${AUTO_RUN_HITL_MARKER}\n\nChange deterministic.txt from before to after.`, ["[AI]-hitl", "[AI]-advanced-difficulty"]);
  const followup = await createIssue(config.repository, "Finish deterministic single-branch change", `${AUTO_RUN_FOLLOWUP_MARKER}\n\nChange deterministic.txt from after to complete.`, ["[AI]-afk", "[AI]-expert-difficulty"]);
  const server = await startFakeAnthropicServer({
    repoRoot: config.cloneRoot,
    resolveRepoRoot: () => isolatedWorktreeRoot(config.cloneRoot),
    diagnosticsPath: config.diagnosticsPath,
    readinessPath: config.readinessPath,
  });
  try {
    const environment = childEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config.claudeConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "aboard-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
      ABOARD_E2E_DIAGNOSTICS: config.diagnosticsPath,
      ABOARD_E2E_REPOSITORY: config.repository,
      ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot,
      ABOARD_E2E_AUTO_RUN_HITL_ISSUE: String(hitl),
      ABOARD_E2E_AUTO_RUN_FOLLOWUP_ISSUE: String(followup),
    });
    const executable = await testExecutable();
    for (const phase of ["initialize", "auto-run-single"]) {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: resolve(__dirname, "..", "..", ".."),
        extensionTestsPath: resolve(__dirname, "suite.js"),
        extensionTestsEnv: { ...environment, ABOARD_E2E_PHASE: phase },
        launchArgs: [config.cloneRoot, "--disable-extensions"],
      });
      if (phase === "initialize") await commitInitializedScaffold(config.cloneRoot, {
        "aboard.autoRun.branchMode": "single-branch",
        "aboard.autoRun.review": false,
        "aboard.autoRun.exploreBeforeImplement": false,
        "aboard.autoRun.issueContextDepth": 1,
        "aboard.autoRun.pauseAfterHitl": true,
        "aboard.autoRun.mergeStrategy": "rebase",
        "aboard.autoRun.mergeRunPullRequest": false,
        "aboard.autoRun.pollSeconds": 3600,
        "aboard.autoRun.discardBehavior": "full-cleanup",
        "aboard.autoRun.worktree.enabled": true,
        "aboard.autoRun.worktree.root": join(config.runtimeRoot, "worktrees"),
        "aboard.autoRun.worktree.keep": false,
        "aboard.autoRun.worktree.setupTimeoutSeconds": 60,
      });
      if (phase === "initialize") await mkdir(join(config.cloneRoot, ".claude"), { recursive: true });
    }
    const assertions = server.assertions();
    for (const checkpoint of [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-commit", "auto-hitl-complete",
      "auto-followup-read", "auto-followup-edit", "auto-followup-commit", "auto-followup-complete",
    ]) {
      if (!assertions.checkpoints.includes(checkpoint)) throw new Error(`Single-branch auto-run did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 8 || assertions.unexpectedRequests !== 0) throw new Error("Unexpected single-branch inference activity");
  } finally {
    await server.close();
    await resetHarness();
  }
}

async function isolatedWorktreeRoot(root: string): Promise<string> {
  const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true })).stdout;
  const roots = output.split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .filter((candidate) => candidate.toLowerCase() !== resolve(root).toLowerCase());
  if (roots.length !== 1) throw new Error(`Expected one active auto-run worktree; found ${roots.length}`);
  return roots[0]!;
}

void runAutoRunJourney().then(runSingleBranchJourney).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Auto-run E2E journey failed"}\n`);
  process.exitCode = 1;
});
