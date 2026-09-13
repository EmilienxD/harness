import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedClaudeEnvironment, runClaude, validateClaudeCli } from "../../core/claude.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { BEFORE, AFTER, MARKER, parseRequest, scenarioCatalogHash, transition } from "./scenario.js";
const exec = promisify(execFile);
export async function runCommitJourney(): Promise<void> {
  await validateClaudeCli();
  const root = await mkdtemp(join(tmpdir(), "harness-commit-e2e-")); const project = join(root, "project"); const config = join(root, "config");
  await mkdir(join(project, ".claude", "hooks"), { recursive: true }); await mkdir(config, { recursive: true });
  await writeFile(join(project, "deterministic.txt"), BEFORE); await exec("git", ["init", "-b", "main"], { cwd: project }); await exec("git", ["config", "user.email", "e2e@example.invalid"], { cwd: project }); await exec("git", ["config", "user.name", "Harness E2E"], { cwd: project }); await exec("git", ["add", "."], { cwd: project }); await exec("git", ["commit", "-m", "seed"], { cwd: project });
  const harness = process.cwd(); await copyFile(join(harness, "harness/engineering/commit/claude/commit_UserPromptSubmit_hook.py"), join(project, ".claude/hooks/commit_UserPromptSubmit_hook.py")); await copyFile(join(harness, "harness/engineering/commit/commit_core.py"), join(project, ".claude/hooks/commit_core.py"));
  await writeFile(join(project, ".claude/settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "python", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/commit_UserPromptSubmit_hook.py"] }] }] } })); await writeFile(join(config, "settings.json"), "{}\n");
  const server = await startFakeAnthropicServer({ repoRoot: project, scenarioCatalogHash, parseRequest, transition });
  try { const result = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", "Read,Edit", "--permission-mode", "acceptEdits", `${MARKER} edit deterministic.txt`], project, isolatedClaudeEnvironment(process.env, { ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, DISABLE_UPDATES: "1", NO_PROXY: "127.0.0.1,localhost" })); if (result.code !== 0) throw new Error(result.stderr); const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "/commit deterministic fixture", cwd: project, transcript_path: "" }); await new Promise<void>((resolve, reject) => { const child = spawn("python", [join(project, ".claude/hooks/commit_UserPromptSubmit_hook.py")], { cwd: project, stdio: ["pipe", "ignore", "pipe"] }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error("commit hook failed"))); child.stdin.end(payload); }); const subject = (await exec("git", ["log", "-1", "--format=%s"], { cwd: project })).stdout.trim(); if (subject !== "deterministic fixture") throw new Error(`unexpected commit subject: ${subject}`); if ((await readFile(join(project, "deterministic.txt"), "utf8")) !== AFTER) throw new Error("fixture edit missing"); if (server.assertions().inferenceRequests !== 1) throw new Error("/commit caused an additional model request"); } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}
