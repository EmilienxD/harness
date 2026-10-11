import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, REVIEW_MARKER, scenarioCatalogHash } from "./scenario.js";
import { copyTree, createFakeGh, findHarnessRoot, initializeRepository, isolatedCodexEnvironment, parseCodexThreadId, pythonCommand, successfulOpenAiRequests, type IssuePlatform } from "../issues/support.js";

const execFileAsync = promisify(execFile);
const HOOK = "issue_readers_hook.py";

export interface IssueReadersJourneyResult {
  readonly checkpoints: readonly string[];
  readonly fileContent: string;
  readonly commitSubject: string;
  readonly reviewText: string;
  readonly unexpectedRequests: number;
}

export async function runIssueReadersJourney(platform: IssuePlatform): Promise<IssueReadersJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), `harness-issue-readers-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "implementation.txt"), "before\n", "utf8");
    const harnessRoot = await findHarnessRoot(process.cwd());
    const python = await pythonCommand();
    await stageIssueReaders(platform, harnessRoot, projectRoot, python);
    await initializeRepository(projectRoot);
    const fakeGh = await createFakeGh(root);
    const commonEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeGh.bin}${delimiter}${process.env.PATH ?? ""}`,
      PYTHONPATH: `${fakeGh.bin}${delimiter}${process.env.PYTHONPATH ?? ""}`,
      HARNESS_E2E_NODE: process.execPath,
      HARNESS_E2E_FAKE_GH: join(fakeGh.bin, "fake-gh.cjs"),
      PYTHONIOENCODING: "utf-8",
      NO_PROXY: "127.0.0.1,localhost",
    };
    let reviewText: string;

    if (platform === "claude") {
      const configRoot = join(root, "claude-config");
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: claudeTransition });
      const env = isolatedClaudeEnvironment(commonEnvironment, {
        ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken,
        CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-issue-readers-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
      });
      const sessionId = randomUUID();
      const first = await runClaude(claudeArgs("/address-this 42", ["--session-id", sessionId]), projectRoot, env);
      requireClaudeSuccess(first, "address-this");
      const resumed = await runClaude(claudeArgs(`/review-this ${REVIEW_MARKER}`, ["--resume", sessionId]), projectRoot, env);
      requireClaudeSuccess(resumed, "resumed review-this");
      reviewText = findFinalText(parseStreamJson(resumed.stdout), resumed.stdout);
    } else {
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: (request) => codexTransition(request, projectRoot) });
      server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] });
      const env = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken, fakeGh.bin);
      const addressOutput = join(root, "codex-address.txt");
      const first = await runCodex(codexArgs(["--output-last-message", addressOutput, "/address-this 42"]), projectRoot, env);
      requireCodexSuccess(first, codexServer, "address-this");
      const sessionId = parseCodexThreadId(first.stdout);
      const reviewOutput = join(root, "codex-review.txt");
      const resumed = await runCodex(codexResumeArgs(sessionId, reviewOutput, `/review-this ${REVIEW_MARKER}`), projectRoot, env);
      requireCodexSuccess(resumed, codexServer, "resumed review-this");
      reviewText = await readFile(reviewOutput, "utf8");
      if (successfulOpenAiRequests(codexServer.assertions()) !== 6) throw new Error("Codex issue-readers journey made an unexpected number of inference requests");
    }

    const assertions = server.assertions();
    const checkpoints = ["address-read", "address-write", "address-stage", "address-commit", "address-complete", "review-complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      throw new Error(`issue-readers checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    }
    return {
      checkpoints,
      fileContent: await readFile(join(projectRoot, "implementation.txt"), "utf8"),
      commitSubject: (await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: projectRoot, encoding: "utf8", windowsHide: true })).stdout.trim(),
      reviewText,
      unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function stageIssueReaders(platform: IssuePlatform, harnessRoot: string, projectRoot: string, python: string): Promise<void> {
  const source = join(harnessRoot, "harness", "building", "issue-readers");
  if (platform === "claude") {
    const claudeRoot = join(projectRoot, ".claude");
    const hookRoot = join(claudeRoot, "hooks");
    await mkdir(hookRoot, { recursive: true });
    for (const skill of ["address-this", "review-this"]) await copyTree(join(source, skill, "SKILL.md"), join(claudeRoot, "skills", skill, "SKILL.md"));
    await copyFile(join(source, HOOK), join(hookRoot, HOOK));
    await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
      { type: "command", command: python, args: [join(hookRoot, HOOK), "--claude"], timeout: 120 },
    ] }] } }, null, 2)}\n`, "utf8");
  } else {
    const hookRoot = join(projectRoot, ".codex", "hooks");
    await mkdir(hookRoot, { recursive: true });
    for (const skill of ["address-this", "review-this"]) {
      await copyTree(join(source, skill, "SKILL.md"), join(projectRoot, ".agents", "skills", skill, "SKILL.md"));
      await copyTree(join(source, skill, "chatgpt", "openai.yaml"), join(projectRoot, ".agents", "skills", skill, "agents", "openai.yaml"));
    }
    await copyFile(join(source, HOOK), join(hookRoot, HOOK));
    await writeFile(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
      { type: "command", command: `${python} \"${join(hookRoot, HOOK)}\" --chatgpt`, timeout: 120 },
    ] }] } }, null, 2)}\n`, "utf8");
  }
}

function claudeArgs(prompt: string, session: readonly string[]): readonly string[] {
  return [
    ...session, "-p", "--output-format", "stream-json", "--verbose", "--prompt-suggestions", "false",
    "--tools", "Read,Edit,Bash", "--allowedTools", "Read,Edit,Bash", "--permission-mode", "acceptEdits", "--permission-prompts", "none", prompt,
  ];
}

function codexArgs(tail: readonly string[]): readonly string[] {
  return ["exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", ...tail];
}

function codexResumeArgs(sessionId: string, output: string, prompt: string): readonly string[] {
  return ["exec", "resume", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", output, sessionId, prompt];
}

function requireClaudeSuccess(result: Awaited<ReturnType<typeof runClaude>>, turn: string): void {
  if (result.timedOut) throw new Error(`Claude Code timed out during ${turn}`);
  if (result.code !== 0) throw new Error(`Claude Code exited ${result.code} during ${turn}: ${redactProcessError(result.stderr)}`);
}

function requireCodexSuccess(result: Awaited<ReturnType<typeof runCodex>>, server: Awaited<ReturnType<typeof startFakeOpenAiServer>>, turn: string): void {
  if (result.timedOut) throw new Error(`Codex timed out during ${turn}`);
  if (result.code !== 0) {
    const structure = server.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
    throw new Error(`Codex exited ${result.code} during ${turn}: ${redactCodexProcessError(result.stderr)}; endpoint: ${structure}`);
  }
}
