import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isolatedClaudeEnvironment, runClaude, validateClaudeCli } from "../../core/claude.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { BEFORE, AFTER, MARKER, parseRequest, scenarioCatalogHash, transition } from "./scenario.js";
const exec = promisify(execFile);

export async function runCommitJourney(): Promise<void> {
  await validateClaudeCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-commit-e2e-"));
  const project = join(root, "project");
  const config = join(root, "config");
  const hook = join(project, ".claude", "hooks", "commit_hook.py");
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  try {
    const python = await pythonCommand();
    await mkdir(dirname(hook), { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(project, "deterministic.txt"), BEFORE);
    await exec("git", ["init", "-b", "main"], { cwd: project });
    await exec("git", ["config", "user.email", "e2e@example.invalid"], { cwd: project });
    await exec("git", ["config", "user.name", "Harness E2E"], { cwd: project });
    await exec("git", ["add", "."], { cwd: project });
    await exec("git", ["commit", "-m", "seed"], { cwd: project });

    const harness = await findHarnessRoot(process.cwd());
    await copyFile(
      join(harness, "harness", "engineering", "commit", "commit_hook.py"),
      hook,
    );
    await copyFile(
      join(harness, "harness", "engineering", "commit", "commit_core.py"),
      join(project, ".claude", "hooks", "commit_core.py"),
    );
    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: python, args: [hook, "--claude"] }] }],
        },
      }),
    );
    await writeFile(join(config, "settings.json"), "{}\n");

    server = await startFakeAnthropicServer({ repoRoot: project, scenarioCatalogHash, parseRequest, transition });
    const result = await runClaude(
      [
        "-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit",
        "--permission-mode", "acceptEdits", `${MARKER} edit deterministic.txt`,
      ],
      project,
      isolatedClaudeEnvironment(process.env, {
        ANTHROPIC_BASE_URL: server.baseUrl,
        ANTHROPIC_AUTH_TOKEN: server.authToken,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_PROJECT_DIR: project,
        DISABLE_UPDATES: "1",
        NO_PROXY: "127.0.0.1,localhost",
      }),
    );
    if (result.code !== 0) throw new Error("Claude CLI did not complete the commit fixture edit");
    const inferenceRequestsBeforeCommit = server.assertions().inferenceRequests;

    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "/commit deterministic fixture",
      cwd: project,
      transcript_path: "",
    });
    const hookResult = await runHook(python, hook, project, payload);
    if (hookResult.code !== 2) {
      throw new Error(`commit hook returned ${hookResult.code ?? "no exit code"}; expected the handled-prompt exit code 2`);
    }
    if (!hookResult.stderr.includes("Committed ")) {
      throw new Error("commit hook blocked the prompt without reporting a completed commit");
    }

    const subject = (await exec("git", ["log", "-1", "--format=%s"], { cwd: project })).stdout.trim();
    if (subject !== "deterministic fixture") throw new Error(`unexpected commit subject: ${subject}`);
    if ((await readFile(join(project, "deterministic.txt"), "utf8")) !== AFTER) throw new Error("fixture edit missing");
    if (server.assertions().inferenceRequests !== inferenceRequestsBeforeCommit) {
      throw new Error("/commit caused an additional model request");
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runHook(
  python: string,
  hook: string,
  cwd: string,
  payload: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, [hook], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => { resolvePromise({ code, stderr }); });
    child.stdin.end(payload);
  });
}

async function pythonCommand(): Promise<string> {
  for (const candidate of ["python3", "python", "py"]) {
    try {
      await exec(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], { windowsHide: true });
      return candidate;
    } catch { }
  }
  throw new Error("commit E2E requires Python 3.11 or newer");
}

async function findHarnessRoot(start: string): Promise<string> {
  let candidate = resolve(start);
  while (true) {
    try {
      await readFile(join(candidate, "harness", "engineering", "commit", "harness.toml"));
      return candidate;
    } catch { }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the Harness checkout");
    candidate = parent;
  }
}
