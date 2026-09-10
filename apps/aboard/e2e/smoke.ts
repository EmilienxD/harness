import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  execCaptured,
  findFinalText,
  isolatedClaudeEnvironment,
  parseStreamJson,
  redactProcessError,
  runClaude,
  validateClaudeCli,
} from "../../../tests/e2e/core/claude.js";
import type { HarnessConfig } from "./config.js";
import { resetLocal } from "./repository.js";
import { AFTER_CONTENT, BEFORE_CONTENT, FINAL_RESPONSE, SCENARIO_MARKER } from "./scenario.js";
import { startFakeAnthropicServer } from "./server.js";

const INITIAL_SKILL_NAME = "aboard-e2e-initial-skill";

export {
  findFinalText,
  isolatedClaudeEnvironment as childEnvironment,
  missingClaudeHelpStructures,
  parseClaudeVersion,
  parseStreamJson,
  redactProcessError,
  validateClaudeCli,
} from "../../../tests/e2e/core/claude.js";

export async function runSmoke(config: HarnessConfig): Promise<void> {
  await validateClaudeCli();
  await resetLocal(config);
  const fixturePath = join(config.cloneRoot, "deterministic.txt");
  const baseline = await readFile(fixturePath, "utf8");
  if (baseline !== BEFORE_CONTENT) throw new Error("Runtime clone does not contain the exact canonical fixture baseline");
  const skillDirectory = join(config.claudeConfigRoot, "skills", INITIAL_SKILL_NAME);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(config.claudeConfigRoot, "settings.json"), "{}\n", { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    `name: ${INITIAL_SKILL_NAME}`,
    "description: Proves that Claude expands a user-only skill passed as its initial CLI prompt.",
    "disable-model-invocation: true",
    "---",
    `${SCENARIO_MARKER} Perform the deterministic fixture update using the available tools, then report completion.`,
    "",
  ].join("\n"), "utf8");

  const server = await startFakeAnthropicServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath });
  try {
    const sessionId = randomUUID();
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit", "--allowedTools", "Read,Edit",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", sessionId,
      `/${INITIAL_SKILL_NAME} Perform the deterministic fixture update.`,
    ];
    const env = isolatedClaudeEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config.claudeConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "harness-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
    });
    const result = await runClaude(args, config.cloneRoot, env);
    if (result.timedOut) throw new Error("Claude Code did not finish the deterministic smoke exchange within 120 seconds");
    if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}; stderr: ${redactProcessError(result.stderr)}`);
    const events = parseStreamJson(result.stdout);
    const finalText = findFinalText(events, result.stdout);
    if (!finalText.includes(FINAL_RESPONSE)) throw new Error("Claude Code stream did not contain the deterministic final response");

    const assertions = server.assertions();
    const reached = new Set(assertions.checkpoints);
    for (const checkpoint of ["read-target", "edit-target", "complete"]) {
      if (!reached.has(checkpoint)) throw new Error(`Fake inference scenario did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 3 || assertions.unexpectedRequests !== 0) {
      throw new Error(`Unexpected inference activity: ${assertions.inferenceRequests} inference requests, ${assertions.unexpectedRequests} rejected requests`);
    }
    const content = await readFile(fixturePath, "utf8");
    if (content !== AFTER_CONTENT) throw new Error("Claude Code did not produce the exact expected fixture content");
    const status = await execCaptured("git", ["status", "--porcelain=v1", "--untracked-files=all"], config.cloneRoot);
    if (status.trim() !== "M deterministic.txt") throw new Error(`Expected deterministic.txt to be the only changed file; observed ${JSON.stringify(status.trim())}`);
  } finally {
    await server.close();
  }
}
