import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, FINAL_MESSAGE, MARKER, scenarioCatalogHash, TARGET_CONTENT } from "./scenario.js";

const execFileAsync = promisify(execFile);
type Platform = "claude" | "chatgpt";

export interface PreferFewerCommentsJourneyResult {
  readonly checkpoints: readonly string[];
  readonly targetContent: string;
  readonly finalText: string;
  readonly unexpectedRequests: number;
}

export async function runPreferFewerCommentsJourney(platform: Platform): Promise<PreferFewerCommentsJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), `harness-prefer-fewer-comments-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  const isolatedTemp = join(root, "tmp");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(isolatedTemp, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    const python = await pythonCommand();
    const hookRoot = join(projectRoot, platform === "claude" ? ".claude" : ".codex", "hooks");
    const configDirectory = dirname(hookRoot);
    const hookPath = join(hookRoot, "prefer_fewer_comments_PostToolUse_hook.py");
    await mkdir(hookRoot, { recursive: true });
    await copyFile(join(harnessRoot, "harness", "guards", "prefer-fewer-comments", "prefer_fewer_comments_PostToolUse_hook.py"), hookPath);
    await copyFile(join(harnessRoot, "harness", "guards", "prefer-fewer-comments", "prefer-fewer-comments.rules"), join(configDirectory, "prefer-fewer-comments.rules"));

    let finalText: string;
    if (platform === "claude") {
      const configRoot = join(root, "claude-config");
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      await writeFile(join(configDirectory, "settings.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit|Bash|PowerShell", hooks: [{ type: "command", command: python, args: [hookPath] }] }] } }, null, 2)}\n`, "utf8");
      server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: claudeTransition });
      const env = isolatedClaudeEnvironment(process.env, {
        ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: configRoot,
        CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-prefer-fewer-comments-e2e",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost", TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp,
      });
      const result = await runClaude([
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "Write", "--allowedTools", "Write",
        "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", randomUUID(), MARKER,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("Claude Code timed out during prefer-fewer-comments E2E");
      if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}; endpoint: ${endpointStructure(server)}`);
      finalText = findFinalText(parseStreamJson(result.stdout), result.stdout);
    } else {
      await writeFile(join(configDirectory, "hooks.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [{ type: "command", command: `${python} \"${hookPath}\"` }] }] } }, null, 2)}\n`, "utf8");
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: codexTransition });
      server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] });
      const outputPath = join(root, "codex-final.txt");
      const env = isolatedCodexEnvironment(process.env, codexHome, codexServer.authToken, isolatedTemp);
      const result = await runCodex([
        "exec", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access",
        "--output-last-message", outputPath, MARKER,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("Codex timed out during prefer-fewer-comments E2E");
      if (result.code !== 0) throw new Error(`Codex exited ${result.code}: ${redactCodexProcessError(result.stderr)}; endpoint: ${endpointStructure(codexServer)}`);
      finalText = await readFile(outputPath, "utf8");
    }

    const assertions = server.assertions();
    const checkpoints = ["comment-heavy-write", "complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) throw new Error(`prefer-fewer-comments checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    if (!finalText.includes(FINAL_MESSAGE)) throw new Error(`${platform} CLI did not report completion`);
    return {
      checkpoints, targetContent: await readFile(join(projectRoot, "target.py"), "utf8"),
      finalText, unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function isolatedCodexEnvironment(parent: NodeJS.ProcessEnv, codexHome: string, token: string, isolatedTemp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent, CODEX_HOME: codexHome, HARNESS_E2E_OPENAI_KEY: token, NO_PROXY: "127.0.0.1,localhost",
    TMP: isolatedTemp, TEMP: isolatedTemp, TMPDIR: isolatedTemp,
  };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
  return env;
}

function endpointStructure(server: { assertions(): { observations: readonly { readonly httpStatus?: unknown; readonly checkpoint?: unknown; readonly diagnostic?: unknown }[] } }): string {
  return server.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try { await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true }); return candidate; }
    catch { }
  }
  throw new Error("prefer-fewer-comments E2E requires Python 3.11 or newer");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try { await readFile(join(candidate, "harness", "guards", "prefer-fewer-comments", "harness.toml")); return candidate; }
    catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
