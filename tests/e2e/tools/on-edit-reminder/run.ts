import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { MARKER, parseRequest, scenarioCatalogHash, TARGET_AFTER, TARGET_BEFORE, transition } from "./scenario.js";

const execFileAsync = promisify(execFile);

export interface OnEditReminderJourneyResult {
  readonly checkpoints: readonly string[];
  readonly targetContent: string;
  readonly unexpectedRequests: number;
}

export async function runOnEditReminderJourney(): Promise<OnEditReminderJourneyResult> {
  await validateClaudeCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-on-edit-reminder-e2e-"));
  const projectRoot = join(root, "project");
  const claudeRoot = join(projectRoot, ".claude");
  const configRoot = join(root, "claude-config");
  const hookPath = join(claudeRoot, "hooks", "on_edit_reminder_hook.py");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  const sessionId = randomUUID();
  const markerPath = join(tmpdir(), `claude_on_edit_reminder_${sessionId}.marker`);
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    await mkdir(dirname(hookPath), { recursive: true });
    await mkdir(configRoot, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    await copyFile(join(harnessRoot, "harness", "guards", "on-edit-reminder", "on_edit_reminder_hook.py"), hookPath);
    await writeFile(join(projectRoot, "target.txt"), TARGET_BEFORE, "utf8");
    await writeFile(join(projectRoot, "GUIDE.md"), "E2E GUIDE: the value must be compliant.\n", "utf8");
    await writeFile(join(claudeRoot, "on-edit-reminder.rules"), "target.txt -> GUIDE.md\n", "utf8");
    await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: await pythonCommand(), args: [hookPath, "--claude"] }] }] } }, null, 2)}\n`, "utf8");
    await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");

    server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest, transition });
    const env = isolatedClaudeEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: configRoot,
      CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-on-edit-reminder-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost",
    });
    const result = await runClaude([
      "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit", "--allowedTools", "Read,Edit",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", sessionId, MARKER,
    ], projectRoot, env);
    if (result.timedOut) throw new Error("Claude Code timed out during on-edit-reminder E2E");
    if (result.code !== 0) {
      const structure = server.assertions().observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
      throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}; endpoint: ${structure}`);
    }
    parseStreamJson(result.stdout);
    const assertions = server.assertions();
    const checkpoints = ["read-target", "edit-landed", "read-guide", "corrected", "complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      throw new Error(`on-edit-reminder checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    }
    return { checkpoints, targetContent: await readFile(join(projectRoot, "target.txt"), "utf8"), unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(markerPath, { force: true });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try { await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { windowsHide: true }); return candidate; }
    catch { }
  }
  throw new Error("on-edit-reminder E2E requires Python 3");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try { await readFile(join(candidate, "harness", "guards", "on-edit-reminder", "harness.toml")); return candidate; }
    catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
