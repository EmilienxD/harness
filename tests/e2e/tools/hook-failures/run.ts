import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { OpenAiProtocolError, startFakeOpenAiServer, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { findHarnessRoot, initializeRepository, isolatedCodexEnvironment, pythonCommand } from "../issues/support.js";

export type HookTool = "auto" | "commit" | "issue-writers" | "mid-prompt-skills" | "grill-me-in-cloud" | "subagents" | "no-new-documents" | "command-guard" | "ship";
export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionStart";
export type Failure = "exception" | "handled" | "policy" | "completed";
const execFileAsync = promisify(execFile);

const SOURCES: Record<HookTool, string> = {
  auto: "harness/vscode/auto/auto_hook.py",
  commit: "harness/engineering/commit/commit_hook.py",
  "issue-writers": "harness/building/issue-writers/issue_writers_hook.py",
  "mid-prompt-skills": "harness/productivity/mid-prompt-skills/mid_prompt_skills_hook.py",
  "grill-me-in-cloud": "harness/planning/grill-me-in-cloud/grill_me_in_cloud_hook.py",
  subagents: "harness/productivity/subagents/runtime/src/subagents_runtime/hooks.py",
  "no-new-documents": "harness/guards/no-new-documents/no_new_documents_hook.py",
  "command-guard": "harness/guards/command-guard/command_guard_hook.py",
  ship: "harness/building/ship/ship_hook.py",
};
const TARGETS: Record<HookTool, string> = {
  auto: "hook.urllib.request.urlopen", commit: "hook._repo_root", "issue-writers": "hook.core.prepare_drafting_context",
  "mid-prompt-skills": "hook.handle", "grill-me-in-cloud": "hook.handle", subagents: "hook.handle",
  "no-new-documents": "hook._configuration", "command-guard": "hook.denial_reason", ship: "hook.check",
};

/** Replace a dependency at the hook boundary, retaining real Codex event delivery and policy output. */
export async function runHookFailureJourney(tool: HookTool, event: HookEvent, failure: Failure = "exception") {
  await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-hook-failure-e2e-"));
  const project = join(root, "project");
  let server: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(join(project, ".codex"), { recursive: true });
    await mkdir(join(project, "docs"));
    const harness = await findHarnessRoot(process.cwd());
    const runtimeSource = join(root, "runtime", "src");
    const payloadRoot = join(root, "payload");
    await mkdir(payloadRoot);
    let source: string;
    if (tool === "subagents") {
      await cp(join(harness, "harness/productivity/subagents/runtime/src"), runtimeSource, {
        recursive: true, filter: (path) => !path.includes("__pycache__"),
      });
      source = join(runtimeSource, "subagents_runtime", "hooks.py");
    } else {
      const packageRoot = dirname(join(harness, SOURCES[tool]));
      for (const name of await readdir(packageRoot)) {
        if (name.endsWith(".py") || (name.endsWith(".toml") && name !== "harness.toml")) {
          await copyFile(join(packageRoot, name), join(payloadRoot, name));
        }
      }
      source = join(payloadRoot, SOURCES[tool].split("/").at(-1)!);
    }
    const driver = join(root, "driver.py");
    await writeFile(driver, [
      "import importlib.util, io, json, os, pathlib, sys",
      // Native Python subprocesses need native toolchain paths from the fixture.
      `os.environ['PATH'] = ${JSON.stringify(process.env.PATH ?? "")}`,
      `source = pathlib.Path(${JSON.stringify(source)})`,
      "sys.path.insert(0, str(source.parent))",
      `sys.path.insert(0, ${JSON.stringify(runtimeSource)})`,
      'spec = importlib.util.spec_from_file_location("fixture_hook", source)',
      "hook = importlib.util.module_from_spec(spec)",
      "sys.modules[spec.name] = hook",
      "spec.loader.exec_module(hook)",
      'sys.argv = [str(source), "--chatgpt"]',
      'def fail(*args, **kwargs): raise RuntimeError("fixture dependency failure")',
      ...(failure === "exception" ? [`${tool === "no-new-documents" && event === "UserPromptSubmit" ? "hook.handle_prompt" : TARGETS[tool]} = fail`] : []),
      ...(failure === "handled" && tool === "commit" ? ["hook._repo_root = lambda *args: None"] : []),
      ...(failure === "completed" && tool === "auto" ? ['hook.urllib.request.urlopen = lambda *a, **k: io.StringIO(json.dumps({"message": "fixture completed"}))'] : []),
      `raise SystemExit(hook.${tool === "commit" || tool === "issue-writers" ? "entrypoint" : "main"}())`,
      "",
    ].join("\n"), "utf8");
    if (failure === "policy") {
      const policy = join(project, ".harness", "guards");
      await mkdir(policy, { recursive: true });
      await writeFile(join(policy, `${tool}.toml`), "invalid = [", "utf8");
    }
    const python = (await execFileAsync(await pythonCommand(), ["-c", "import sys; print(sys.executable)"], { windowsHide: true })).stdout.trim().replaceAll("\\", "/");
    await writeFile(join(project, ".codex", "hooks.json"), JSON.stringify({ hooks: {
      [event]: [{ hooks: [{ type: "command", command: `${process.platform === "win32" ? "& " : ""}"${python}" "${driver}"`, timeout: 15 }] }],
    } }), "utf8");
    await writeFile(join(project, "sentinel.txt"), "before\n", "utf8");
    await initializeRepository(project);
    if (failure === "completed" && tool === "commit") await writeFile(join(project, "sentinel.txt"), "after\n", "utf8");
    server = await startFakeOpenAiServer({
      scenarioCatalogHash: createHash("sha256").update("hook-failures:v1").digest("hex"),
      transition: (request) => transition(request, event, tool),
    });
    const home = await prepareCodexHome({ root, baseUrl: server.baseUrl, trustedProjects: [project], extraConfig: ["[features]", "hooks = true"] });
    const env = isolatedCodexEnvironment({
      ...process.env,
      PYTHONPATH: `${runtimeSource}${delimiter}${process.env.PYTHONPATH ?? ""}`,
      PYTHONIOENCODING: "utf-8", HARNESS_STATE_DIR: join(root, "state"),
      HARNESS_EXECUTION_MODE: tool === "ship" ? "loop" : "interactive",
      ABOARD_BRIDGE_PORT: "1", ABOARD_BRIDGE_TOKEN: "fixture-only",
    }, home, server.authToken, root);
    if (failure === "handled" && tool === "auto") {
      delete env.ABOARD_BRIDGE_PORT;
      delete env.ABOARD_BRIDGE_TOKEN;
    }
    const prompt = tool === "auto" ? "$auto" : tool === "commit" ? (failure === "completed" ? "$commit fixture completion" : "$commit fixture failure") : tool === "issue-writers" ? "$draft-issue fixture" : "fixture";
    const result = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", prompt], project, env, 30_000);
    if (result.timedOut) throw new Error(`Codex did not settle for ${tool} ${event}`);
    return {
      code: result.code, inferenceRequests: server.assertions().inferenceRequests,
      unexpectedRequests: server.assertions().unexpectedRequests,
      sentinel: await readFile(join(project, "sentinel.txt"), "utf8"),
      commitSubject: failure === "completed" && tool === "commit"
        ? (await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: project, windowsHide: true, encoding: "utf8" })).stdout.trim() : null,
    };
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function transition(request: OpenAiResponsesRequest, event: HookEvent, tool: HookTool): OpenAiScenarioResponse {
  if (event === "UserPromptSubmit" || event === "SessionStart") throw new OpenAiProtocolError("$.input", "blocked prompt reached inference", "hook-failures");
  const results = request.input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
  if (event !== "Stop" && results.length === 0) {
    const write = `${process.platform === "win32" ? "& " : ""}"${process.execPath.replaceAll("\\", "/")}" -e "require('node:fs').writeFileSync('sentinel.txt','after\\n')"`;
    const command = tool === "no-new-documents" ? `echo fixture > docs/fixture.md; ${write}` : write;
    return { scenario: "hook-failures", checkpoint: "attempt", output: request.codeMode
      ? { type: "custom_tool_call", id: "ctc_failure", call_id: "call_failure", name: "exec", status: "completed", input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command })}); text(JSON.stringify(r));` }
      : { type: "function_call", id: "fc_failure", call_id: "call_failure", name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: command }) } };
  }
  if (event !== "Stop" && results.length !== 1) throw new OpenAiProtocolError("$.input", "unexpected tool result count", "hook-failures");
  if (event !== "Stop") {
    const output = JSON.stringify(results[0]);
    const reason = /fixture dependency failure|policy.*(?:load|configuration)|could not.*(?:check|load)|invalid.*configuration/iu;
    if (!reason.test(output)) throw new OpenAiProtocolError("$.input", "hook failure was not delivered as tool feedback", "hook-failures");
  }
  return { scenario: "hook-failures", checkpoint: "complete", output: { type: "message", id: "msg_failure_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture complete", annotations: [] }] } };
}
