import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runTests } from "@vscode/test-electron";

import { loadConfig } from "../config.js";
import { AUTO_RUN_AFK_MARKER, AUTO_RUN_FOLLOWUP_MARKER, AUTO_RUN_HITL_MARKER, AUTO_RUN_HITL_REVIEW_MARKER, AUTO_RUN_NESTED_CONTEXT, AUTO_RUN_PERMANENT_NOTE } from "../scenario.js";
import { startFakeAnthropicServer } from "../server.js";
import { childEnvironment, validateClaudeCli } from "../smoke.js";
import { prepareCodexHome, validateCodexCli } from "../chatgpt.js";
import { startFakeOpenAiServer } from "../codex-server.js";
import { prepareInteractiveClaudeConfig, testExecutable } from "./support.js";

const execFileAsync = promisify(execFile);

type E2ePlatform = "claude" | "chatgpt";

export async function runAutoRunJourney(platform: E2ePlatform): Promise<void> {
  const config = loadConfig();
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  await resetHarness();
  await clearTestAutoRunRecords();
  const platformConfigRoot = platform === "claude" ? config.claudeConfigRoot : join(config.runtimeRoot, "codex-config");
  await rm(platformConfigRoot, { recursive: true, force: true });
  await mkdir(platformConfigRoot, { recursive: true });
  if (platform === "claude") await prepareInteractiveClaudeConfig(platformConfigRoot, [config.cloneRoot, resolve(__dirname, "..", "..", "..")]);
  const issues = await createIssues(config.repository);
  const server = platform === "claude"
    ? await startFakeAnthropicServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath })
    : await startFakeOpenAiServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath });
  const activeConfigRoot = platform === "chatgpt" ? await prepareCodexHome(platformConfigRoot, server.baseUrl, [config.cloneRoot]) : platformConfigRoot;
  await installHarnessWorkerSkills(platform === "chatgpt" ? join(config.cloneRoot, ".agents") : activeConfigRoot);
  try {
    const providerEnvironment = platform === "claude" ? {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: platformConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "harness-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
    } : {
      CODEX_HOME: activeConfigRoot,
      ABOARD_E2E_OPENAI_KEY: server.authToken,
      // The parent Node test process can advertise a non-interactive terminal.
      // VS Code's integrated terminal supports the TUI, so do not let Codex
      // stop at its TERM=dumb confirmation before SessionStart.
      TERM: "xterm-256color",
    };
    const environment = childEnvironment(process.env, {
      ...providerEnvironment,
      NO_PROXY: "127.0.0.1,localhost",
      ABOARD_E2E_DIAGNOSTICS: config.diagnosticsPath,
      ABOARD_E2E_REPOSITORY: config.repository,
      ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot,
      ABOARD_E2E_AUTO_RUN_ISSUE: String(issues.primary),
      ABOARD_E2E_AUTO_RUN_CONTEXT_ISSUES: `${issues.context},${issues.nested}`,
      ABOARD_E2E_PLATFORM: platform,
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
      }, platform);
    }
    const assertions = server.assertions();
    for (const checkpoint of ["auto-explore-read", "auto-explore-complete", "auto-afk-read", "auto-afk-edit", "auto-afk-commit", "auto-afk-complete", "auto-review-commit", "auto-review-complete"]) {
      const expected = platform === "chatgpt" ? `auto-run-afk:${checkpoint}` : checkpoint;
      if (!assertions.checkpoints.includes(expected)) throw new Error(`Auto-run journey did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 8 || assertions.unexpectedRequests !== 0) {
      throw new Error(`Unexpected ${platform} auto-run inference activity: ${assertions.inferenceRequests} inference requests, ${assertions.unexpectedRequests} rejected requests`);
    }
  } finally {
    await server.close();
    await resetHarness();
  }
}

async function commitInitializedScaffold(root: string, settings: Readonly<Record<string, unknown>>, platform: E2ePlatform): Promise<void> {
  const launchPath = join(root, ".harness", "launch.json");
  const launch = JSON.parse(await readFile(launchPath, "utf8")) as Record<string, unknown>;
  if (platform === "claude") launch.command = [
    "claude",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Bash(git add*),Bash(git commit*)",
  ];
  else {
    for (const key of Object.keys(launch)) delete launch[key];
    Object.assign(launch, { version: 2, platform: "chatgpt", command: ["codex"] });
  }
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`, "utf8");
  const settingsPath = join(root, ".vscode", "settings.json");
  await mkdir(join(root, ".vscode"), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  if (settings["aboard.autoRun.worktree.enabled"] === true) await installWorktreeTrustSetup(root, platform);
  const hooks = join(root, ".git", "e2e-empty-hooks");
  await mkdir(hooks, { recursive: true });
  await execFileAsync("git", ["add", "--", ".abd", ".harness/launch.json", ".vscode/settings.json", ...(platform === "chatgpt" ? [".agents"] : [])], { cwd: root, encoding: "utf8", windowsHide: true });
  await execFileAsync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "commit", "--message", "Initialize aboard E2E fixture"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "harness e2e",
      GIT_AUTHOR_EMAIL: "harness-e2e@invalid.example",
      GIT_COMMITTER_NAME: "harness e2e",
      GIT_COMMITTER_EMAIL: "harness-e2e@invalid.example",
      GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
    },
  });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: root, encoding: "utf8", windowsHide: true });
}

async function installHarnessWorkerSkills(configRoot: string): Promise<void> {
  const harnessRoot = resolve(__dirname, "..", "..", "..", "..", "..");
  for (const name of ["address-this", "review-this"]) {
    const destination = join(configRoot, "skills", name, "SKILL.md");
    await mkdir(join(configRoot, "skills", name), { recursive: true });
    await copyFile(join(harnessRoot, "harness", "building", "issue-readers", name, "SKILL.md"), destination);
  }
}

async function installWorktreeTrustSetup(root: string, platform: E2ePlatform): Promise<void> {
  const script = platform === "claude" ? [
    "$configPath = Join-Path $env:CLAUDE_CONFIG_DIR '.claude.json'",
    "$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json",
    "$trustedPath = [IO.Path]::GetFullPath($PWD.Path).Replace('\\', '/')",
    "$trust = [ordered]@{ allowedTools = @(); mcpContextUris = @(); mcpServers = @{}; enabledMcpjsonServers = @(); disabledMcpjsonServers = @(); hasTrustDialogAccepted = $true; hasClaudeMdExternalIncludesApproved = $false; hasClaudeMdExternalIncludesWarningShown = $false }",
    "$config.projects | Add-Member -NotePropertyName $trustedPath -NotePropertyValue $trust -Force",
    "$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding utf8",
    "",
  ].join("\n") : [
    "$configPath = Join-Path $env:CODEX_HOME 'config.toml'",
    "$trustedPath = [IO.Path]::GetFullPath($PWD.Path).ToLowerInvariant()",
    "$tomlPath = $trustedPath.Replace(\"'\", \"''\")",
    "Add-Content -LiteralPath $configPath -Encoding utf8 -Value \"`n[projects.'$tomlPath']`ntrust_level = `\"trusted`\"\"",
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

async function runHitlJourney(platform: E2ePlatform, branchMode: "per-issue" | "single-branch", review: boolean): Promise<void> {
  const config = loadConfig();
  await resetHarness();
  // Windows' unelevated sandbox provisions every writable Git object path.
  // Keep the long-lived disposable fixture packed so linked-worktree launches
  // exercise the permission boundary instead of timing out on stale loose objects.
  await execFileAsync("git", ["gc"], { cwd: config.cloneRoot, encoding: "utf8", windowsHide: true });
  await clearTestAutoRunRecords();
  const hitlMarker = review ? AUTO_RUN_HITL_REVIEW_MARKER : AUTO_RUN_HITL_MARKER;
  const hitl = await createIssue(config.repository, `Accept deterministic ${branchMode} change${review ? " after review" : ""}`, `${hitlMarker}\n\nChange deterministic.txt from before to after.`, ["[AI]-hitl", "[AI]-advanced-difficulty"]);
  const followup = review
    ? undefined
    : await createIssue(config.repository, `Finish deterministic ${branchMode} change`, `${AUTO_RUN_FOLLOWUP_MARKER}\n\nChange deterministic.txt from after to complete.`, ["[AI]-afk", "[AI]-expert-difficulty"]);
  const platformConfigRoot = platform === "claude" ? config.claudeConfigRoot : join(config.runtimeRoot, "codex-config");
  await rm(platformConfigRoot, { recursive: true, force: true });
  await mkdir(platformConfigRoot, { recursive: true });
  if (platform === "claude") {
    await prepareInteractiveClaudeConfig(platformConfigRoot, [config.cloneRoot, resolve(__dirname, "..", "..", "..")]);
    await installHarnessWorkerSkills(platformConfigRoot);
  }
  const server = platform === "claude"
    ? await startFakeAnthropicServer({ repoRoot: config.cloneRoot, resolveRepoRoot: () => isolatedWorktreeRoot(config.cloneRoot), diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath })
    : await startFakeOpenAiServer({ repoRoot: config.cloneRoot, resolveRepoRoot: () => isolatedWorktreeRoot(config.cloneRoot), diagnosticsPath: config.diagnosticsPath });
  let activeConfigRoot = platformConfigRoot;
  if (platform === "chatgpt") {
    activeConfigRoot = await prepareCodexHome(platformConfigRoot, server.baseUrl, [config.cloneRoot]);
    await installHarnessWorkerSkills(join(config.cloneRoot, ".agents"));
  }
  try {
    const providerEnvironment = platform === "claude" ? {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: platformConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "harness-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
    } : {
      CODEX_HOME: activeConfigRoot,
      ABOARD_E2E_OPENAI_KEY: server.authToken,
      TERM: "xterm-256color",
    };
    const environment = childEnvironment(process.env, {
      ...providerEnvironment,
      NO_PROXY: "127.0.0.1,localhost",
      ABOARD_E2E_DIAGNOSTICS: config.diagnosticsPath,
      ABOARD_E2E_REPOSITORY: config.repository,
      ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot,
      ABOARD_E2E_AUTO_RUN_HITL_ISSUE: String(hitl),
      ABOARD_E2E_AUTO_RUN_FOLLOWUP_ISSUE: followup === undefined ? "" : String(followup),
      ABOARD_E2E_AUTO_RUN_REVIEW: String(review),
      ABOARD_E2E_PLATFORM: platform,
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
        "aboard.autoRun.branchMode": branchMode,
        "aboard.autoRun.review": review,
        "aboard.autoRun.exploreBeforeImplement": false,
        "aboard.autoRun.issueContextDepth": 1,
        "aboard.autoRun.mergeStrategy": "rebase",
        "aboard.autoRun.mergeRunPullRequest": false,
        "aboard.autoRun.discardBehavior": "full-cleanup",
        "aboard.autoRun.worktree.enabled": true,
        "aboard.autoRun.worktree.root": join(config.runtimeRoot, "worktrees"),
        "aboard.autoRun.worktree.keep": false,
        "aboard.autoRun.worktree.setupTimeoutSeconds": 60,
      }, platform);
      if (phase === "initialize" && platform === "claude") await mkdir(join(config.cloneRoot, ".claude"), { recursive: true });
    }
    const assertions = server.assertions();
    const expectedCheckpoints = review ? [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-commit", "auto-hitl-complete",
      "auto-hitl-review-read", "auto-hitl-review-complete", "auto-hitl-accept-commit", "auto-hitl-accept-complete",
    ] : [
      "auto-hitl-read", "auto-hitl-edit", "auto-hitl-handoff", "auto-hitl-commit", "auto-hitl-complete",
      "auto-followup-read", "auto-followup-edit", "auto-followup-commit", "auto-followup-complete",
    ];
    for (const checkpoint of expectedCheckpoints) {
      const scenario = checkpoint.startsWith("auto-hitl-") ? review ? "auto-run-hitl-review" : "auto-run-hitl" : "auto-run-followup";
      const expected = platform === "chatgpt" ? `${scenario}:${checkpoint}` : checkpoint;
      if (!assertions.checkpoints.includes(expected)) throw new Error(`HITL auto-run did not reach ${checkpoint}`);
    }
    const expectedRequests = review ? 8 : 9;
    if (assertions.inferenceRequests !== expectedRequests || assertions.unexpectedRequests !== 0) throw new Error("Unexpected HITL inference activity");
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

void (async () => {
  for (const platform of ["claude", "chatgpt"] as const) {
    const selected = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=")[1];
    if (selected !== undefined && selected !== platform) continue;
    if (!process.argv.includes("--hitl")) await runAutoRunJourney(platform);
    for (const mode of ["per-issue", "single-branch"] as const) {
      for (const review of [false, true]) await runHitlJourney(platform, mode, review);
    }
  }
})()
  .catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Auto-run E2E journey failed"}\n`);
  process.exitCode = 1;
});
