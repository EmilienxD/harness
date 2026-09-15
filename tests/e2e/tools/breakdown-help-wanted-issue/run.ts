import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { findFinalText, isolatedClaudeEnvironment, parseStreamJson, redactProcessError, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, redactCodexProcessError, runCodex, validateCodexCli } from "../../core/codex.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { claudeTransition, codexTransition, FIXTURE_CONTENT, FIXTURE_FILE, scenarioCatalogHash } from "./scenario.js";
import { copyTree, findHarnessRoot, initializeRepository, isolatedCodexEnvironment, pythonCommand, type IssuePlatform } from "../issues/support.js";

export interface BreakdownHelpWantedIssueJourneyResult { readonly checkpoints: readonly string[]; readonly report: string; readonly githubMutations: number; readonly unexpectedRequests: number; }

export async function runBreakdownHelpWantedIssueJourney(platform: IssuePlatform): Promise<BreakdownHelpWantedIssueJourneyResult> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), `harness-breakdown-${platform}-e2e-`)); const projectRoot = join(root, "project"); const diagnosticsPath = join(root, "structural-diagnostics.json");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(projectRoot, { recursive: true }); await writeFile(join(projectRoot, FIXTURE_FILE), FIXTURE_CONTENT, "utf8");
    const harnessRoot = await findHarnessRoot(process.cwd()); const python = await pythonCommand(); await stageTool(platform, harnessRoot, projectRoot, python); await initializeRepository(projectRoot);
    const fakeGh = await createFakeGh(root);
    const commonEnvironment: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeGh.bin}${delimiter}${process.env.PATH ?? ""}`, PYTHONPATH: `${fakeGh.bin}${delimiter}${process.env.PYTHONPATH ?? ""}`, HARNESS_E2E_NODE: process.execPath, HARNESS_E2E_FAKE_GH: fakeGh.scriptPath, PYTHONIOENCODING: "utf-8", NO_PROXY: "127.0.0.1,localhost" };
    let report: string;
    if (platform === "claude") {
      const configRoot = join(root, "claude-config"); await mkdir(configRoot, { recursive: true }); await writeFile(join(configRoot, "settings.json"), "{}\n", "utf8");
      server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash, parseRequest: parseAnthropicMessagesRequest, transition: (request) => claudeTransition(request, projectRoot) });
      const env = isolatedClaudeEnvironment(commonEnvironment, { ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECT_DIR: projectRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "harness-breakdown-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" });
      const result = await runClaude(["--session-id", randomUUID(), "-p", "--output-format", "stream-json", "--verbose", "--prompt-suggestions", "false", "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "/breakdown-help-wanted-issue"], projectRoot, env);
      if (result.timedOut) throw new Error("Claude Code timed out during breakdown-help-wanted-issue"); if (result.code !== 0) throw new Error(`Claude Code exited ${result.code}: ${redactProcessError(result.stderr)}`);
      report = findFinalText(parseStreamJson(result.stdout), result.stdout);
    } else {
      const codexServer = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash, transition: codexTransition }); server = codexServer;
      const codexHome = await prepareCodexHome({ root, baseUrl: codexServer.baseUrl, trustedProjects: [projectRoot], extraConfig: ["[features]", "hooks = true"] }); const env = isolatedCodexEnvironment(commonEnvironment, codexHome, codexServer.authToken, fakeGh.bin); const output = join(root, "codex-report.txt");
      const result = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--output-last-message", output, "$breakdown-help-wanted-issue"], projectRoot, env);
      if (result.timedOut) throw new Error("Codex timed out during breakdown-help-wanted-issue"); if (result.code !== 0) throw new Error(`Codex exited ${result.code}: ${redactCodexProcessError(result.stderr)}`); report = await readFile(output, "utf8");
    }
    const assertions = server.assertions(); const checkpoints = ["inspect-current-behavior", "report-complete"];
    if (checkpoints.some((checkpoint) => !assertions.checkpoints.includes(checkpoint))) throw new Error(`breakdown checkpoints incomplete: ${assertions.checkpoints.join(", ")}`);
    const ghState = JSON.parse(await readFile(fakeGh.statePath, "utf8")) as { calls: string[][] }; const githubMutations = ghState.calls.filter((args) => !args.includes("--method") || args[args.indexOf("--method") + 1] !== "GET").length;
    return { checkpoints, report, githubMutations, unexpectedRequests: assertions.unexpectedRequests };
  } finally { await server?.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function stageTool(platform: IssuePlatform, harnessRoot: string, projectRoot: string, python: string): Promise<void> {
  const source = join(harnessRoot, "harness", "planning", "breakdown-help-wanted-issue"); const hookName = "breakdown_help_wanted_issue_hook.py";
  if (platform === "claude") {
    const root = join(projectRoot, ".claude"); await copyTree(source, join(root, "skills", "breakdown-help-wanted-issue")); await mkdir(join(root, "hooks"), { recursive: true }); await copyFile(join(source, hookName), join(root, "hooks", hookName));
    await writeFile(join(root, "settings.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: python, args: [join(root, "hooks", hookName), "--claude"], timeout: 30 }] }] } }, null, 2)}\n`, "utf8");
  } else {
    const skill = join(projectRoot, ".agents", "skills", "breakdown-help-wanted-issue"); await copyTree(source, skill); await mkdir(join(skill, "agents"), { recursive: true }); await copyFile(join(source, "chatgpt", "openai.yaml"), join(skill, "agents", "openai.yaml"));
    const hooks = join(projectRoot, ".codex", "hooks"); await mkdir(hooks, { recursive: true }); await copyFile(join(source, hookName), join(hooks, hookName));
    await writeFile(join(projectRoot, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${python} \"${join(hooks, hookName)}\" --chatgpt`, timeout: 30 }] }] } }, null, 2)}\n`, "utf8");
  }
}

async function createFakeGh(root: string): Promise<{ bin: string; scriptPath: string; statePath: string }> {
  const bin = join(root, "bin"); const statePath = join(root, "fake-gh-state.json"); const scriptPath = join(bin, "fake-gh.cjs"); await mkdir(bin, { recursive: true }); await writeFile(statePath, '{"calls":[]}\n', "utf8");
  const source = `const fs=require("node:fs");const statePath=${JSON.stringify(statePath)};const args=process.argv.slice(2);const state=JSON.parse(fs.readFileSync(statePath,"utf8"));state.calls.push(args);fs.writeFileSync(statePath,JSON.stringify(state,null,2)+"\\n");const fields=args.filter((value,index)=>args[index-1]==="-f");const expected=["state=open","labels=[AI]-help-wanted","sort=created","direction=asc","per_page=100","page=1"];if(args[0]!=="api"||args[1]!=="repos/{owner}/{repo}/issues"||args[2]!=="--method"||args[3]!=="GET"||JSON.stringify(fields)!==JSON.stringify(expected)){process.stderr.write("unexpected fake gh call\\n");process.exit(2)}process.stdout.write(JSON.stringify([{number:3,pull_request:{url:"https://github.test/pulls/3"}},{number:17,html_url:"https://github.test/fixture/issues/17",title:"Retry failed imports",created_at:"2026-01-01T00:00:00Z",body:"Users should retry failed imports without uploading the source file again."}])+"\\n");`;
  await writeFile(scriptPath, source, "utf8"); await writeFile(join(bin, "sitecustomize.py"), `import os, subprocess\n_real=subprocess.run\ndef run(args,*p,**k):\n if isinstance(args,(list,tuple)) and args and args[0]=="gh": args=[os.environ["HARNESS_E2E_NODE"],os.environ["HARNESS_E2E_FAKE_GH"],*args[1:]]\n return _real(args,*p,**k)\nsubprocess.run=run\n`, "utf8"); await writeFile(join(bin, "gh.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-gh.cjs" %*\r\n`, "utf8"); return { bin, scriptPath, statePath };
}
