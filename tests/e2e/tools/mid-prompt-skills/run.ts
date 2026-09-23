import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { FINAL_MESSAGE, LEAD_BODY, LEAD_SKILL, LEADING_PROMPT, MID_BODY, MID_PROMPT, MID_SKILL, parseRequest, scenarioCatalogHash, transition } from "./scenario.js";

const execFileAsync = promisify(execFile);
const HOOK = "mid_prompt_skills_hook.py";

export interface MidPromptSkillsJourneyResult {
  readonly checkpoints: readonly string[];
  readonly finalTexts: readonly string[];
  readonly unexpectedRequests: number;
}

export async function runMidPromptSkillsJourney(): Promise<MidPromptSkillsJourneyResult> {
  await validateClaudeCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-mid-prompt-skills-e2e-"));
  const projectRoot = join(root, "project");
  const claudeRoot = join(projectRoot, ".claude");
  const configRoot = join(root, "claude-config");
  const hookPath = join(claudeRoot, "hooks", HOOK);
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    await mkdir(dirname(hookPath), { recursive: true });
    await mkdir(configRoot, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    await copyFile(join(harnessRoot, "harness", "productivity", "mid-prompt-skills", HOOK), hookPath);
    for (const [name, body] of [[LEAD_SKILL, LEAD_BODY], [MID_SKILL, MID_BODY]] as const) {
      await mkdir(join(claudeRoot, "skills", name), { recursive: true });
      await writeFile(join(claudeRoot, "skills", name, "SKILL.md"), `---\ndescription: ${name}\ndisable-model-invocation: true\n---\n${body}\n`, "utf8");
    }
    const handler = { type: "command", command: await pythonCommand(), args: [hookPath, "--claude"] };
    await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: {
      UserPromptExpansion: [{ hooks: [handler] }], UserPromptSubmit: [{ hooks: [handler] }],
    } }, null, 2)}\n`, "utf8");
    await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");

    server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest, transition });
    const env = isolatedClaudeEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: configRoot,
      CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-mid-prompt-skills-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost", PYTHONIOENCODING: "utf-8",
    });
    const finalTexts: string[] = [];
    for (const prompt of [MID_PROMPT, LEADING_PROMPT]) {
      const result = await runClaude([
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read", "--allowedTools", "Read",
        "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", randomUUID(), prompt,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("Claude Code timed out during mid-prompt-skills E2E");
      if (result.code !== 0) {
        const structure = server.assertions().observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
        throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}; endpoint: ${structure}`);
      }
      finalTexts.push(findFinalText(parseStreamJson(result.stdout), result.stdout));
    }
    const assertions = server.assertions();
    const checkpoints = ["mid-prompt-skill", "leading-and-later-skill"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      const structure = assertions.observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
      throw new Error(`mid-prompt-skills checkpoints incomplete: ${assertions.checkpoints.join(", ")}; endpoint: ${structure}`);
    }
    if (finalTexts.some((text) => !text.includes(FINAL_MESSAGE))) throw new Error("Claude Code did not report completion");
    return { checkpoints, finalTexts, unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try { await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 8)"], { windowsHide: true }); return candidate; }
    catch { }
  }
  throw new Error("mid-prompt-skills E2E requires Python 3");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try { await readFile(join(candidate, "harness", "productivity", "mid-prompt-skills", "harness.toml")); return candidate; }
    catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
