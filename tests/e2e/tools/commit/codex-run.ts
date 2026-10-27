import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { OpenAiProtocolError, startFakeOpenAiServer } from "../../core/openai-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { findHarnessRoot, initializeRepository, isolatedCodexEnvironment, parseCodexThreadId, pythonCommand } from "../issues/support.js";

const exec = promisify(execFile);
export type ContextMode = "healthy" | "storage-failure" | "lookup-failure" | "verified";

export async function runCodexCommitContextJourney(mode: ContextMode): Promise<void> {
  await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-commit-context-e2e-"));
  const project = join(root, "project");
  let server: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    await mkdir(join(project, ".codex", "hooks"), { recursive: true });
    const harness = await findHarnessRoot(process.cwd());
    const hook = join(project, ".codex", "hooks", "commit_hook.py");
    await copyFile(join(harness, "harness/engineering/commit/commit_hook.py"), hook);
    await copyFile(join(harness, "harness/engineering/commit/commit_ownership.py"), join(project, ".codex/hooks/commit_ownership.py"));
    const entrypoint = join(root, "driver.py");
    await writeFile(entrypoint, [
      "import importlib.util, pathlib, os, sys",
      `sys.path.insert(0, ${JSON.stringify(join(project, ".codex/hooks"))})`,
      // Hook shells can replace PATH; retain the fixture toolchain for Git.
      `os.environ['PATH'] = ${JSON.stringify(process.env.PATH ?? "")}`,
      `pathlib.Path(${JSON.stringify(join(root, "hook-launched"))}).touch()`,
      `spec = importlib.util.spec_from_file_location('fixture_hook', ${JSON.stringify(hook)})`,
      "hook = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(hook)",
      "def fail(*args):",
      `    pathlib.Path(${JSON.stringify(join(root, "lookup-attempted"))}).touch()`,
      "    raise OSError('fixture Git lookup failure')",
      ...(mode === "lookup-failure" ? ["hook._repo_root = fail"] : []),
      ...(mode === "storage-failure" ? [
        "original_record = hook._record_prompt",
        "def record(*args):",
        "    try:",
        "        return original_record(*args)",
        "    except OSError:",
        `        pathlib.Path(${JSON.stringify(join(root, "storage-failed"))}).touch()`,
        "        raise",
        "hook._record_prompt = record",
      ] : []),
      "hook.entrypoint(['--chatgpt'])",
      "",
    ].join("\n"));
    const python = (await exec(await pythonCommand(), ["-c", "import sys; print(sys.executable)"])).stdout.trim().replaceAll("\\", "/");
    const fragment = JSON.parse(await readFile(join(harness, "harness/engineering/commit/chatgpt/hooks.fragment.json"), "utf8"));
    for (const groups of Object.values(fragment.hooks) as { hooks: { command: string }[] }[][]) for (const group of groups) {
      for (const item of group.hooks) item.command = `${process.platform === "win32" ? "& " : ""}"${python}" "${entrypoint}" --chatgpt`;
    }
    await writeFile(join(project, ".codex", "hooks.json"), JSON.stringify({ hooks: mode === "verified" ? fragment.hooks : {
      UserPromptSubmit: fragment.hooks.UserPromptSubmit,
    } }));
    await writeFile(join(project, "sentinel.txt"), "before\n");
    await initializeRepository(project);
    const commitState = join(root, "state", "runtime", "commit");
    if (mode === "storage-failure") {
      // A regular file makes all per-session context directories unwritable.
      await mkdir(join(root, "state", "runtime"), { recursive: true });
      await writeFile(commitState, "blocked\n");
    }
    server = await startFakeOpenAiServer({
      scenarioCatalogHash: createHash("sha256").update("commit-context:v1").digest("hex"),
      transition: (request) => {
        if (mode === "verified") {
          const outputs = request.input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
          if (outputs.length === 0) {
            const patch = "*** Begin Patch\n*** Update File: sentinel.txt\n@@\n-before\n+after\n*** End Patch";
            const output = request.codeMode
              ? { type: "custom_tool_call" as const, id: "ctc_commit_write", call_id: "call_commit_write", name: "exec", status: "completed" as const, input: `const r = await tools.apply_patch(${JSON.stringify(patch)}); text(JSON.stringify(r));` }
              : { type: "function_call" as const, id: "fc_commit_write", call_id: "call_commit_write", name: "exec_command", status: "completed" as const, arguments: JSON.stringify({ cmd: process.platform === "win32" ? "Set-Content -LiteralPath sentinel.txt -Value after -Encoding utf8" : "echo after > sentinel.txt", yield_time_ms: 10_000, max_output_tokens: 1000 }) };
            return { scenario: "commit-context", checkpoint: "verified-write", output };
          }
          if (outputs.length !== 1 || outputs[0]?.call_id !== "call_commit_write") throw new OpenAiProtocolError("$.input", "unexpected tool history", "commit-context");
        } else if (request.input.some((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output") ||
            !request.input.some((item) => item.role === "user")) {
          throw new OpenAiProtocolError("$.input", "unexpected history", "commit-context");
        }
        return { scenario: "commit-context", checkpoint: "ordinary-prompt-allowed", output: {
          type: "message", id: "msg_context_done", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Context fixture complete.", annotations: [] }],
        } };
      },
    });
    const home = await prepareCodexHome({ root, baseUrl: server.baseUrl, trustedProjects: [project], extraConfig: ["[features]", "hooks = true"] });
    const env = isolatedCodexEnvironment({
      ...process.env, PYTHONIOENCODING: "cp1252:surrogateescape", HARNESS_STATE_DIR: join(root, "state"),
    }, home, server.authToken, root);
    const output = join(root, "answer.txt");
    const result = await runCodex([
      "exec", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message", output, "Explain \u201cthis\u201d with \u00e9 and \ud83d\ude00.",
    ], project, env, 30_000);
    assert.equal(result.timedOut, false);
    await readFile(join(root, "hook-launched"));
    assert.equal(result.code, 0);
    assert.equal((await readFile(output, "utf8")).trim(), "Context fixture complete.");
    assert.equal(server.assertions().inferenceRequests, mode === "verified" ? 2 : 1);
    assert.equal(server.assertions().unexpectedRequests, 0);
    assert.equal((await readFile(join(project, "sentinel.txt"), "utf8")).trim(), mode === "verified" ? "after" : "before");
    if (mode === "lookup-failure") await readFile(join(root, "lookup-attempted"));
    if (mode === "storage-failure") await readFile(join(root, "storage-failed"));
    await assert.rejects(access(join(project, ".git", "harness")));
    if (mode === "healthy" || mode === "verified") {
      const checkouts = await readdir(join(commitState, "v2"));
      assert.equal(checkouts.length, 1);
      const sessions = join(commitState, "v2", checkouts[0]!, "chatgpt");
      const ids = await readdir(sessions);
      assert.equal(ids.length, 1);
      const prompts = await readdir(join(sessions, ids[0]!, "prompts"));
      assert.equal(prompts.length, 1);
      const record = JSON.parse(await readFile(join(sessions, ids[0]!, "prompts", prompts[0]!), "utf8"));
      assert.equal(typeof record.prompt, "string");
      // Check Unicode validity without coupling acceptance to prompt wording.
      assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(record.prompt), false);
      const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: project })).stdout;
      if (mode === "healthy") await writeFile(join(project, "sentinel.txt"), "after\n");
      const committed = await runCodex([
        "exec", "resume", "--json", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox",
        parseCodexThreadId(result.stdout), "$commit context fixture",
      ], project, env, 30_000);
      assert.equal(committed.timedOut, false);
      assert.equal(committed.code, 0);
      const nextHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: project })).stdout;
      if (mode === "verified") {
        assert.notEqual(nextHead, head);
        assert.equal((await exec("git", ["show", "--pretty=", "--name-only"], { cwd: project })).stdout.trim(), "sentinel.txt");
      } else assert.equal(nextHead, head);
      assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: project })).stdout, "");
      assert.equal(server.assertions().inferenceRequests, mode === "verified" ? 2 : 1);
      assert.equal(server.assertions().unexpectedRequests, 0);
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
