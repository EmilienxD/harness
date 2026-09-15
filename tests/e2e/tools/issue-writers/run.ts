import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { isolatedClaudeEnvironment, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { DRAFT_MARKER, DRAFT_NAME, claudeTransition, codexTransition, scenarioCatalogHash } from "./scenario.js";
import { copyTree, createFakeGh, findHarnessRoot, initializeRepository, isolatedCodexEnvironment, parseCodexThreadId, pythonCommand, readPublishedIssue, successfulOpenAiRequests, type FakeIssue, type IssuePlatform } from "../issues/support.js";

export interface IssueWritersJourneyResult {
  readonly checkpoints: readonly string[];
  readonly inferenceRequestsBeforePublish: number;
  readonly inferenceRequestsAfterPublish: number;
  readonly draftExistsAfterPublish: boolean;
  readonly published: FakeIssue;
  readonly unexpectedRequests: number;
}

export async function runIssueWritersJourney(platform: IssuePlatform): Promise<IssueWritersJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), `harness-issue-writers-${platform}-e2e-`));
  const projectRoot = join(root, "project");
  const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true });
    const harnessRoot = await findHarnessRoot(process.cwd());
    const python = await pythonCommand();
    await stageIssueWriters(platform, harnessRoot, projectRoot, python);
    await writeFile(join(projectRoot, "README.md"), "# Fixture project\n", "utf8");
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
    let inferenceRequestsBeforePublish: number;
    let inferenceRequestsAfterPublish: number;
    let draftPath: string;

    if (platform === "claude") {
      const configRoot = join(root, "claude-config");
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      const claudeServer = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: claudeTransition });
      server = claudeServer;
      const env = isolatedClaudeEnvironment(commonEnvironment, {
        ANTHROPIC_BASE_URL: claudeServer.baseUrl, ANTHROPIC_AUTH_TOKEN: claudeServer.authToken,
        CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_CODE_PROJECT_DIR_NAME: "harness-issue-writers-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
      });
      const sessionId = randomUUID();
      draftPath = join(projectRoot, ".issues-gateway", sessionId, DRAFT_NAME);
      const first = await runClaude(claudeArgs(`/draft-issue ${DRAFT_MARKER}`, ["--session-id", sessionId], "Write"), projectRoot, env);
      requireClaudeDraftSuccess(first);
      inferenceRequestsBeforePublish = claudeServer.assertions().inferenceRequests;
      const resumed = await runClaude(claudeArgs("/publish-issues", ["--resume", sessionId], ""), projectRoot, env);
      requireHookPublicationResult(resumed.code, resumed.timedOut, `${resumed.stdout}\n${resumed.stderr}`, "Claude Code");
      inferenceRequestsAfterPublish = claudeServer.assertions().inferenceRequests;
    } else {
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: (request) => codexTransition(request, projectRoot) });
      server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] });
      const env = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken, fakeGh.bin);
      const firstOutput = join(root, "codex-draft.txt");
      const first = await runCodex(codexArgs(["--output-last-message", firstOutput, `$draft-issue ${DRAFT_MARKER}`]), projectRoot, env);
      requireCodexDraftSuccess(first, codexServer);
      const sessionId = parseCodexThreadId(first.stdout);
      draftPath = await onlyDraftPath(projectRoot);
      inferenceRequestsBeforePublish = successfulOpenAiRequests(codexServer.assertions());
      const publishOutput = join(root, "codex-publish.txt");
      const resumed = await runCodex(codexResumeArgs(sessionId, publishOutput, "$publish-issues"), projectRoot, env);
      requireSilentHookCompletion(resumed.code, resumed.timedOut, "Codex");
      inferenceRequestsAfterPublish = successfulOpenAiRequests(codexServer.assertions());
    }

    const assertions = server.assertions();
    const checkpoints = ["draft-write", "draft-complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) {
      throw new Error(`issue-writers checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    }
    return {
      checkpoints,
      inferenceRequestsBeforePublish,
      inferenceRequestsAfterPublish,
      draftExistsAfterPublish: await exists(draftPath),
      published: await readPublishedIssue(fakeGh.statePath),
      unexpectedRequests: assertions.unexpectedRequests,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function stageIssueWriters(platform: IssuePlatform, harnessRoot: string, projectRoot: string, python: string): Promise<void> {
  const source = join(harnessRoot, "harness", "building", "issue-writers");
  const skills = ["draft-issue", "draft-issues", "draft-audit-issues", "publish-issues", "to-spec", "to-spec-draft-issue"];
  if (platform === "claude") {
    const claudeRoot = join(projectRoot, ".claude");
    const hookRoot = join(claudeRoot, "hooks");
    await mkdir(hookRoot, { recursive: true });
    for (const skill of skills) await copyTree(join(source, skill), join(claudeRoot, "skills", skill));
    await copyTree(join(source, "copy-message-as-issue"), join(claudeRoot, "skills", "copy-message-as-issue"));
    for (const file of ["issues_core.py", "claude/publish_issues_UserPromptSubmit_hook.py", "claude/copy_message_as_issue.py"]) {
      await copyFile(join(source, file), join(hookRoot, file.split("/").at(-1)!));
    }
    await writeFile(join(claudeRoot, "settings.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
      type: "command", command: python, args: [join(hookRoot, "publish_issues_UserPromptSubmit_hook.py")], timeout: 300,
    }] }] } }, null, 2)}\n`, "utf8");
  } else {
    const hookRoot = join(projectRoot, ".codex", "hooks");
    await mkdir(hookRoot, { recursive: true });
    for (const skill of skills) {
      await copyTree(join(source, skill), join(projectRoot, ".agents", "skills", skill));
      await mkdir(join(projectRoot, ".agents", "skills", skill, "agents"), { recursive: true });
      await copyFile(join(source, "chatgpt", "agents", `${skill}.yaml`), join(projectRoot, ".agents", "skills", skill, "agents", "openai.yaml"));
    }
    await copyFile(join(source, "issues_core.py"), join(hookRoot, "issues_core.py"));
    await copyFile(join(source, "chatgpt", "issues_ChatGPT_hook.py"), join(hookRoot, "issues_ChatGPT_hook.py"));
    await writeFile(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
      type: "command", command: `${python} \"${join(hookRoot, "issues_ChatGPT_hook.py")}\"`, timeout: 300,
    }] }] } }, null, 2)}\n`, "utf8");
  }
}

function claudeArgs(prompt: string, session: readonly string[], tools: string): readonly string[] {
  return [
    ...session, "-p", "--output-format", "stream-json", "--verbose", "--prompt-suggestions", "false",
    "--tools", tools, "--allowedTools", tools, "--permission-mode", "acceptEdits", "--permission-prompts", "none", prompt,
  ];
}

function codexArgs(tail: readonly string[]): readonly string[] {
  return ["exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", ...tail];
}

function codexResumeArgs(sessionId: string, output: string, prompt: string): readonly string[] {
  return ["exec", "resume", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", output, sessionId, prompt];
}

function requireClaudeDraftSuccess(result: Awaited<ReturnType<typeof runClaude>>): void {
  if (result.timedOut) throw new Error("Claude Code timed out drafting an issue");
  if (result.code !== 0) throw new Error(`Claude Code exited ${result.code} drafting an issue: ${redactProcessError(result.stderr)}`);
}

function requireCodexDraftSuccess(result: Awaited<ReturnType<typeof runCodex>>, server: Awaited<ReturnType<typeof startFakeOpenAiServer>>): void {
  if (result.timedOut) throw new Error("Codex timed out drafting an issue");
  if (result.code !== 0) {
    const structure = server.assertions().observations.map((item) => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
    throw new Error(`Codex exited ${result.code} drafting an issue: ${redactCodexProcessError(result.stderr)}; endpoint: ${structure}`);
  }
}

function requireHookPublicationResult(code: number | null, timedOut: boolean, output: string, cli: string): void {
  if (timedOut) throw new Error(`${cli} timed out during hook-only publication`);
  if (!output.includes("Published 1 issue(s) successfully.")) {
    throw new Error(`${cli} did not report successful hook-only publication (exit ${code})`);
  }
}

function requireSilentHookCompletion(code: number | null, timedOut: boolean, cli: string): void {
  if (timedOut) throw new Error(`${cli} timed out during hook-only publication`);
  if (code !== 0) throw new Error(`${cli} exited ${code} during hook-only publication`);
}

async function onlyDraftPath(projectRoot: string): Promise<string> {
  const gateway = join(projectRoot, ".issues-gateway");
  const batches = (await readdir(gateway, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/iu.test(entry.name));
  if (batches.length !== 1) throw new Error("ChatGPT drafting did not create exactly one session batch");
  return join(gateway, batches[0]!.name, DRAFT_NAME);
}

async function exists(path: string): Promise<boolean> {
  try { await import("node:fs/promises").then(({ access }) => access(path)); return true; } catch { return false; }
}
