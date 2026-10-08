import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { claudeTransition, codexTransition, CONTENT, MARKER, type Method, type Platform, scenarioCatalogHash, TARGET } from "./scenario.js";

const execFileAsync = promisify(execFile);

export interface JourneyResult { readonly checkpoints: readonly string[]; readonly content: string; readonly unexpectedRequests: number }

export async function runPreferFewerCommentsJourney(platform: Platform, method: Method): Promise<JourneyResult> {
  if (platform === "chatgpt" && method !== "shell") throw new Error("Codex journey supports shell writes");
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), `harness-prefer-fewer-comments-${platform}-${method}-e2e-`));
  const project = join(root, "project");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  const source = join(await findHarnessRoot(process.cwd()), "harness", "guards", "prefer-fewer-comments");
  const python = await pythonCommand();
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const provider = platform === "claude" ? ".claude" : ".codex";
    const hook = join(project, provider, "hooks", "prefer_fewer_comments_hook.py");
    await mkdir(dirname(hook), { recursive: true });
    await copyFile(join(source, "prefer_fewer_comments_hook.py"), hook);
    const fragment = JSON.parse(await readFile(join(source, platform === "claude" ? "claude" : "chatgpt", platform === "claude" ? "settings.fragment.json" : "hooks.fragment.json"), "utf8"));
    const matcher = fragment.hooks.PostToolUse[0].matcher;
    const hookCommand = platform === "claude" ? { type: "command", command: python, args: [hook, "--claude"] } : { type: "command", command: `${python} \"${hook}\" --chatgpt`, timeout: 30 };
    await writeFile(join(project, provider, platform === "claude" ? "settings.json" : "hooks.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher, hooks: [hookCommand] }] } }, null, 2)}\n`, "utf8");
    if (platform === "claude") {
      const config = join(root, "claude-config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "settings.json"), "{}\n", "utf8");
      server = await startFakeAnthropicServer({ repoRoot: project, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: (request) => claudeTransition(request, project, method) });
      const env = isolatedClaudeEnvironment(process.env, {
        ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: config,
        CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-prefer-fewer-comments-e2e",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1",
        DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost",
      });
      const tool = method === "native" ? "Write" : "Bash";
      const result = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", tool, "--allowedTools", tool,
        "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", randomUUID(), MARKER], project, env);
      if (result.timedOut || result.code !== 0) throw new Error(`Claude exited ${result.code}, timedOut=${result.timedOut}: ${redactProcessError(result.stderr)}`);
      parseStreamJson(result.stdout);
    } else {
      server = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: codexTransition });
      const home = await prepareCodexHome({ root, baseUrl: server.baseUrl, trustedProjects: [project], extraConfig: ["[features]", "hooks = true", "[features.code_mode]", "enabled = true"] });
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, HARNESS_E2E_OPENAI_KEY: server.authToken, NO_PROXY: "127.0.0.1,localhost" };
      for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
      const result = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access", MARKER], project, env);
      if (result.timedOut || result.code !== 0) {
        const observations = server.assertions().observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(", ");
        throw new Error(`Codex exited ${result.code}, timedOut=${result.timedOut}: ${redactCodexProcessError(result.stderr)}; endpoint: ${observations}`);
      }
    }
    const assertions = server.assertions();
    if (!["write", "reminder"].every((step) => assertions.checkpoints.includes(step))) throw new Error(`missing checkpoints: ${assertions.checkpoints.join(", ")}`);
    return { checkpoints: ["write", "reminder"], content: await readFile(join(project, TARGET), "utf8"), unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try { await execFileAsync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true }); return candidate; }
    catch { /* try next */ }
  }
  throw new Error("Python 3.11 or newer is required");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try { await readFile(join(candidate, "harness", "guards", "prefer-fewer-comments", "harness.toml")); return candidate; }
    catch { /* look upward */ }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
