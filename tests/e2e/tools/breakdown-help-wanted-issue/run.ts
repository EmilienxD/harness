import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, FIXTURE_CONTENT, FIXTURE_FILE, scenarioCatalogHash } from "./scenario.js";
import { findHarnessRoot, initializeRepository, isolatedCodexEnvironment, type IssuePlatform } from "../issues/support.js";

export interface BreakdownHelpWantedIssueJourneyResult { readonly checkpoints: readonly string[]; readonly report: string; readonly unexpectedRequests: number; }

export async function runBreakdownHelpWantedIssueJourney(platform: IssuePlatform): Promise<BreakdownHelpWantedIssueJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), `harness-breakdown-${platform}-e2e-`)); const projectRoot = join(root, "project"); const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true }); await writeFile(join(projectRoot, FIXTURE_FILE), FIXTURE_CONTENT, "utf8");
    const harnessRoot = await findHarnessRoot(process.cwd()); await stageTool(platform, harnessRoot, projectRoot); await initializeRepository(projectRoot);
    const commonEnvironment: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: "127.0.0.1,localhost" };
    let report: string;
    if (platform === "claude") {
      const configRoot = join(root, "claude-config"); await mkdir(configRoot, { recursive: true }); await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: (request) => claudeTransition(request, projectRoot) });
      const env = isolatedClaudeEnvironment(commonEnvironment, { ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-breakdown-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" });
      const result = await runClaude(["--session-id", randomUUID(), "-p", "--output-format", "stream-json", "--verbose", "--prompt-suggestions", "false", "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "/breakdown-help-wanted-issue Let users retry failed imports without uploading the source file again."], projectRoot, env);
      if (result.timedOut) throw new Error("Claude Code timed out during breakdown-help-wanted-issue"); if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}`);
      report = findFinalText(parseStreamJson(result.stdout), result.stdout);
    } else {
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: (request) => codexTransition(request, projectRoot) }); server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot] }); const env = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken, dirname(process.execPath)); const output = join(root, "codex-report.txt");
      const result = await runCodex(["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", output, "$breakdown-help-wanted-issue Let users retry failed imports without uploading the source file again."], projectRoot, env);
      if (result.timedOut) throw new Error("Codex timed out during breakdown-help-wanted-issue");
      if (result.code !== 0) {
        const structure = codexServer.assertions().observations
          .map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
        throw new Error(`Codex exited ${result.code}: ${redactCodexProcessError(result.stderr)}; endpoint: ${structure}`);
      }
      report = await readFile(output, "utf8");
    }
    const assertions = server.assertions(); const checkpoints = ["inspect-current-behavior", "report-complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) throw new Error(`breakdown checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    return { checkpoints, report, unexpectedRequests: assertions.unexpectedRequests };
  } finally { await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function stageTool(platform: IssuePlatform, harnessRoot: string, projectRoot: string): Promise<void> {
  const source = join(harnessRoot, "harness", "planning", "breakdown-help-wanted-issue");
  const skill = join(projectRoot, platform === "claude" ? ".claude" : ".agents", "skills", "breakdown-help-wanted-issue");
  await mkdir(skill, { recursive: true });
  await copyFile(join(source, "SKILL.md"), join(skill, "SKILL.md"));
  if (platform === "chatgpt") {
    await mkdir(join(skill, "agents"), { recursive: true });
    await copyFile(join(source, "chatgpt", "openai.yaml"), join(skill, "agents", "openai.yaml"));
  }
}
