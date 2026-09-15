import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import {
  findFinalText,
  isolatedClaudeEnvironment,
  parseStreamJson,
  redactProcessError,
  runClaude,
  validateClaudeCli,
} from "../../core/claude.js";
import {
  PARENT_COMPLETE,
  PARENT_MARKER,
  scenarioCatalogHash,
  transition,
} from "./scenario.js";

const execFileAsync = promisify(execFile);

interface JobMeta {
  readonly delivered?: unknown;
}

export interface RedirectSubagentsJourneyResult {
  readonly checkpoints: readonly string[];
  readonly redirectedJobs: number;
  readonly deliveredJobs: number;
  readonly unexpectedRequests: number;
}

export async function runRedirectSubagentsJourney(): Promise<RedirectSubagentsJourneyResult> {
  await validateClaudeCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-redirect-subagents-e2e-"));
  const projectRoot = join(root, "project");
  const home = join(root, "home");
  const configRoot = join(home, ".claude");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    const harnessRoot = await findHarnessRoot(process.cwd());
    const packageRoot = join(harnessRoot, "harness", "guards", "redirect-subagents");
    const python = await pythonCommand();
    await stagePayload(packageRoot, projectRoot, python);
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
    await writeFile(join(home, ".claude.json"), `${JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [projectRoot]: { hasTrustDialogAccepted: true } },
    }, null, 2)}\n`, "utf8");

    server = await startFakeAnthropicServer({
      repoRoot: projectRoot,
      diagnosticsPath,
      scenarioCatalogHash,
      parseRequest: parseAnthropicMessagesRequest,
      transition,
    });
    const environment = isolatedClaudeEnvironment(process.env, {
      HOME: home,
      USERPROFILE: home,
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: configRoot,
      CLAUDE_PROJECT_DIR: projectRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "harness-redirect-subagents-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
      PYTHONIOENCODING: "utf-8",
    });
    const processResult = await runClaude([
      "-p", "--output-format", "stream-json", "--verbose",
      "--tools", "Agent", "--allowedTools", "Agent",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--session-id", randomUUID(),
      `${PARENT_MARKER} Delegate once to Explore and use its redirected report.`,
    ], projectRoot, environment);
    if (processResult.timedOut) throw new Error("Claude Code timed out during the redirect-subagents journey");
    if (processResult.code !== 0) {
      const structure = server.assertions().observations
        .map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
      throw new Error(`Claude Code exited ${processResult.code}; stderr: ${redactProcessError(processResult.stderr)}; endpoint: ${structure}`);
    }
    const events = parseStreamJson(processResult.stdout);
    if (!findFinalText(events, processResult.stdout).includes(PARENT_COMPLETE)) {
      throw new Error("the parent CLI did not finish with the redirected child report");
    }

    const expected = ["parent-agent-request", "parent-waiting", "child-complete", "parent-received-report"];
    const assertions = server.assertions();
    const checkpoints = assertions.checkpoints;
    if (JSON.stringify(checkpoints) !== JSON.stringify(expected)) {
      throw new Error(`redirect-subagents checkpoint order changed: ${checkpoints.join(", ")}`);
    }
    const jobs = await readJobs(join(projectRoot, ".claude", "harness-redirect-subagents"));
    return {
      checkpoints,
      redirectedJobs: jobs.length,
      deliveredJobs: jobs.filter((job) => job.delivered === true).length,
      unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function stagePayload(packageRoot: string, projectRoot: string, python: string): Promise<void> {
  const sourceRoot = join(packageRoot, "claude");
  const claudeRoot = join(projectRoot, ".claude");
  const hooksRoot = join(claudeRoot, "hooks");
  const stateRoot = join(claudeRoot, "harness-redirect-subagents");
  await mkdir(hooksRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  for (const name of [
    "rs_io.py",
    "redirect_subagents_deny_PreToolUse_hook.py",
    "redirect_subagents_notify_PostToolUse_hook.py",
    "redirect_subagents_wait_hook.py",
  ]) await copyFile(join(sourceRoot, name), join(hooksRoot, name));
  await copyFile(join(sourceRoot, "gitignore.template"), join(stateRoot, ".gitignore"));
  await copyFile(join(sourceRoot, "subagents.example.json"), join(stateRoot, "subagents.json"));
  await writeFile(join(stateRoot, "subagents.json"), `${JSON.stringify({ Explore: "auto" }, null, 2)}\n`, "utf8");

  const fragment = JSON.parse(await readFile(join(sourceRoot, "settings.fragment.json"), "utf8")) as unknown;
  const rendered = replaceTokens(fragment, python, claudeRoot);
  await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify(rendered, null, 2)}\n`, "utf8");
}

function replaceTokens(value: unknown, python: string, claudeRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll("${PYTHON}", python).replaceAll("${CLAUDE_DIR}", claudeRoot);
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, python, claudeRoot));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, python, claudeRoot)]));
  }
  return value;
}

async function readJobs(stateRoot: string): Promise<readonly JobMeta[]> {
  const entries = await readdir(stateRoot, { withFileTypes: true });
  const jobs: JobMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { jobs.push(JSON.parse(await readFile(join(stateRoot, entry.name, "meta.json"), "utf8")) as JobMeta); }
    catch { }
  }
  return jobs;
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      const result = await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 8); print(sys.executable)"], {
        encoding: "utf8", windowsHide: true,
      });
      return result.stdout.trim();
    } catch { }
  }
  throw new Error("redirect-subagents E2E requires Python 3.8 or newer");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await readFile(join(candidate, "harness", "guards", "redirect-subagents", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
