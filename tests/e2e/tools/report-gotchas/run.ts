import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { isolatedClaudeEnvironment, findFinalText, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, FINAL_MESSAGE, MARKER, REPORT_MARKER, scenarioCatalogHash } from "./scenario.js";

const execFileAsync = promisify(execFile);
type Platform = "claude" | "chatgpt";

export interface ReportGotchasJourneyResult {
  readonly checkpoints: readonly string[];
  readonly delivered: boolean;
  readonly finalText: string;
  readonly unexpectedRequests: number;
}

export async function runReportGotchasJourney(platform: Platform): Promise<ReportGotchasJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const webhookUrl = await configuredWebhookUrl();
  const root = await mkdtemp(join(tmpdir(), `harness-report-gotchas-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    const runtimeSource = join(harnessRoot, "harness", "productivity", "report-gotchas", "runtime", "src");
    const skillSource = join(harnessRoot, "harness", "productivity", "report-gotchas", "SKILL.md");
    const python = await pythonCommand(runtimeSource);
    const bin = join(root, "bin");
    await createCommandShim(bin, python);
    await initializeRepository(projectRoot);
    const submitCommand = reportCommand(platform);
    let finalText: string;

    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}`,
      HARNESS_REPORT_GOTCHAS_STATE_DIR: stateRoot,
      HARNESS_REPORT_GOTCHAS_WEBHOOK_URL: webhookUrl,
      NO_PROXY: "127.0.0.1,localhost",
    };

    if (platform === "claude") {
      const configRoot = join(root, "claude-config");
      const claudeRoot = join(projectRoot, ".claude");
      await mkdir(join(claudeRoot, "skills", "report-gotchas"), { recursive: true });
      await mkdir(configRoot, { recursive: true });
      await copyFile(skillSource, join(claudeRoot, "skills", "report-gotchas", "SKILL.md"));
      await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: python, args: ["-m", "report_gotchas.hooks", "--claude"], timeout: 30 }] }] } }, null, 2)}\n`, "utf8");
      server = await startFakeAnthropicServer({
        repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest,
        transition: (request) => claudeTransition(request, submitCommand),
      });
      const env = isolatedClaudeEnvironment(commonEnvironment, {
        ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken,
        CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-report-gotchas-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
      });
      const result = await runClaude([
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "Skill,Bash", "--allowedTools", "Skill,Bash",
        "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--session-id", randomUUID(),
        `${MARKER} Finish the implementation handoff and autonomously report its noteworthy caveat before the final response.`,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("Claude Code timed out during report-gotchas E2E");
      if (result.code !== 0) {
        throw new Error(
          `Claude Code exited ${result.code}; stderr: ${redactProcessError(result.stderr)}; stdout tail: ${redactProcessTail(result.stdout)}`,
        );
      }
      const events = parseStreamJson(result.stdout);
      finalText = findFinalText(events, result.stdout);
    } else {
      const codexRoot = join(projectRoot, ".codex");
      const skillPath = join(projectRoot, ".agents", "skills", "report-gotchas", "SKILL.md");
      await mkdir(dirname(skillPath), { recursive: true });
      await mkdir(codexRoot, { recursive: true });
      await copyFile(skillSource, skillPath);
      await writeFile(join(codexRoot, "hooks.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${python} -m report_gotchas.hooks --chatgpt`, timeout: 30 }] }] } }, null, 2)}\n`, "utf8");
      const codexServer = await startFakeOpenAiServer({
        diagnosticsPath, scenarioCatalogHash,
        transition: (request) => codexTransition(request, readCommand(skillPath), submitCommand),
      });
      server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] });
      const outputPath = join(root, "codex-final.txt");
      const env = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken);
      const result = await runCodex([
        "exec", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access",
        "--output-last-message", outputPath,
        `${MARKER} Finish the implementation handoff and autonomously use the appropriate available skill to report its noteworthy caveat.`,
      ], projectRoot, env);
      if (result.timedOut) throw new Error("Codex timed out during report-gotchas E2E");
      if (result.code !== 0) {
        const structure = codexServer.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
        throw new Error(`Codex exited ${result.code}: ${redactCodexProcessError(result.stderr)}; endpoint: ${structure}`);
      }
      finalText = await readFile(outputPath, "utf8");
    }

    if (!finalText.includes(FINAL_MESSAGE)) throw new Error("real CLI did not reach the report-gotchas completion response");
    const delivered = await waitForDelivery(stateRoot);
    const assertions = server.assertions();
    const checkpoints = ["skill-loaded", "report-submitted", "complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      throw new Error(`report-gotchas checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    }
    return { checkpoints, delivered, finalText, unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function configuredWebhookUrl(): Promise<string> {
  const environment = process.env.HARNESS_REPORT_GOTCHAS_E2E_WEBHOOK_URL;
  if (environment) return validateWebhookUrl(environment);
  const path = join(homedir(), ".harness", "report-gotchas", "config.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.webhook_url !== "string") throw new Error("invalid configuration");
    return validateWebhookUrl(value.webhook_url);
  } catch {
    throw new Error("report-gotchas live E2E needs a configured Discord webhook; run harness-report-gotchas configure first");
  }
}

function validateWebhookUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || !(url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")) || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("report-gotchas live E2E configuration is not a Discord HTTPS webhook URL");
  }
  return url.toString();
}

async function initializeRepository(projectRoot: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "report-gotchas-e2e@example.invalid"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Report Gotchas E2E"], { cwd: projectRoot, windowsHide: true });
  await writeFile(join(projectRoot, "implementation.txt"), "completed\n", "utf8");
  await execFileAsync("git", ["add", "implementation.txt"], { cwd: projectRoot, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "E2E fixture"], { cwd: projectRoot, windowsHide: true });
  await writeFile(join(projectRoot, "unverified.txt"), "requires review\n", "utf8");
}

async function createCommandShim(bin: string, python: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  const path = join(bin, "harness-report-gotchas");
  await writeFile(path, `#!/bin/sh\nexec ${shellQuote(python)} -m report_gotchas.cli "$@"\n`, "utf8");
  await chmod(path, 0o755);
  if (process.platform === "win32") {
    await writeFile(join(bin, "harness-report-gotchas.cmd"), `@echo off\r\n${python} -m report_gotchas.cli %*\r\n`, "utf8");
  }
}

function reportCommand(platform: Platform): string {
  const body = `**${REPORT_MARKER}**\n\n## Caveats\n\n- This notification came from the live real-CLI E2E journey and can be deleted.`;
  if (platform === "chatgpt" && process.platform === "win32") return `@'\n${body}\n'@ | harness-report-gotchas submit`;
  return `harness-report-gotchas submit <<'HARNESS_GOTCHAS'\n${body}\nHARNESS_GOTCHAS`;
}

function readCommand(path: string): string {
  if (process.platform === "win32") return `Get-Content -Raw -LiteralPath '${path.replaceAll("'", "''")}'`;
  return `cat ${shellQuote(path)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForDelivery(stateRoot: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await jsonFiles(join(stateRoot, "drafts"))).length === 0 && (await jsonFiles(join(stateRoot, "queue"))).length === 0) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Discord did not confirm report-gotchas delivery within 60 seconds");
}

async function jsonFiles(path: string): Promise<readonly string[]> {
  try { return (await readdir(path)).filter((name) => name.endsWith(".json")); } catch { return []; }
}

async function pythonCommand(runtimeSource: string): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await execFileAsync(candidate, ["-c", "import report_gotchas, sys; assert sys.version_info >= (3, 11)"], {
        env: { ...process.env, PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}` }, windowsHide: true,
      });
      return candidate;
    } catch { }
  }
  throw new Error("report-gotchas E2E requires Python 3.11 or newer");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await access(join(candidate, "harness", "productivity", "report-gotchas", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}

function isolatedCodexEnvironment(parent: NodeJS.ProcessEnv, codexHome: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, CODEX_HOME: codexHome, HARNESS_E2E_OPENAI_KEY: token };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
  return env;
}

function redactProcessTail(output: string): string {
  const redacted = output.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").trim();
  return redacted.slice(-2_000) || "no stdout";
}
