import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { GUIDE_MARKER, MARKER, parseRequest, scenarioCatalogHash, TARGET_AFTER, TARGET_BEFORE, transition } from "./scenario.js";

const execFileAsync = promisify(execFile);

export interface OnEditBlockJourneyResult {
  readonly checkpoints: readonly string[];
  readonly targetContent: string;
  readonly unexpectedRequests: number;
}

export async function runOnEditBlockJourney(): Promise<OnEditBlockJourneyResult> {
  await validateClaudeCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-on-edit-block-e2e-"));
  const configRoot = join(root, "claude-config");
  const projectRoot = join(root, "project");
  const claudeRoot = join(projectRoot, ".claude");
  const hookPath = join(claudeRoot, "hooks", "on_edit_block_PreToolUse_hook.py");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    await mkdir(dirname(hookPath), { recursive: true });
    await mkdir(configRoot, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    await copyFile(join(harnessRoot, "harness", "guards", "on-edit-block", "claude", "on_edit_block_PreToolUse_hook.py"), hookPath);
    await writeFile(join(projectRoot, "target.txt"), TARGET_BEFORE, "utf8");
    await writeFile(join(projectRoot, "GUIDE.md"), `${GUIDE_MARKER}\n`, "utf8");
    await writeFile(join(claudeRoot, "on-edit-block.rules"), "target.txt -> GUIDE.md\n", "utf8");
    await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: await pythonCommand(), args: [hookPath] }] }] } }, null, 2)}\n`, "utf8");
    await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");

    server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest, transition });
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit", "--allowedTools", "Read,Edit",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", randomUUID(),
      `${MARKER} Update target.txt exactly as instructed. If a hook denies the edit, use its supplied context and retry.`,
    ];
    const env = isolatedClaudeEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: configRoot,
      CLAUDE_PROJECT_DIR: projectRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "harness-on-edit-block-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
    });
    const processResult = await runClaude(args, projectRoot, env);
    if (processResult.timedOut) throw new Error("Claude Code timed out during the on-edit-block journey");
    if (processResult.code !== 0) {
      const state = server.assertions();
      const structure = state.observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
      throw new Error(`Claude Code exited ${processResult.code}; stderr: ${redactProcessError(processResult.stderr)}; endpoint: ${structure}`);
    }
    parseStreamJson(processResult.stdout);
    const assertions = server.assertions();
    const targetContent = await readFile(join(projectRoot, "target.txt"), "utf8");
    if (targetContent !== TARGET_AFTER) throw new Error("the real Edit retry did not produce the expected target bytes");
    const expected = ["read-target", "edit-denied", "edit-retried", "complete"];
    if (expected.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      throw new Error(`on-edit-block scenario checkpoints were incomplete: ${assertions.checkpoints.join(", ")}`);
    }
    return { checkpoints: expected, targetContent, unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { windowsHide: true });
      return candidate;
    } catch { }
  }
  throw new Error("on-edit-block E2E requires a working Python 3 interpreter");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await readFile(join(candidate, "harness", "guards", "on-edit-block", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
