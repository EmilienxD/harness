import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli e2e\n");
  process.exit(0);
}

const actualSessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560";
const statePath = join(process.cwd(), ".fake-codex-session.json");

if (process.argv.includes("app-server")) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "fake-codex-e2e" } })}\n`);
    } else if (request.method === "thread/read") {
      let saved;
      try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch { saved = undefined; }
      if (saved?.sessionId === request.params?.threadId) {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: saved.sessionId, ephemeral: false, status: { type: "notLoaded" } } } })}\n`);
      } else {
        process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32600, message: "thread not found" } })}\n`);
      }
    }
  }
  process.exit(0);
}

const resumeIndex = process.argv.indexOf("resume");
const resumedSessionId = resumeIndex < 0 ? undefined : process.argv[resumeIndex + 1];
const separator = process.argv.lastIndexOf("--");
const prompt = separator < 0 ? "" : process.argv[separator + 1] ?? "";
const reference = /@([^;]+);/u.exec(prompt)?.[1];
const delivered = reference === undefined ? prompt : readFileSync(reference, "utf8");
if (resumedSessionId === undefined && !delivered.includes("[E2E:chatgpt-")) process.exit(91);
if (resumedSessionId !== undefined) {
  let saved;
  try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch { saved = undefined; }
  if (saved?.sessionId !== resumedSessionId) process.exit(4);
} else {
  writeFileSync(statePath, `${JSON.stringify({ sessionId: actualSessionId })}\n`, "utf8");
}

const readOnly = process.argv.includes('sandbox_mode="read-only"');
if (readOnly && !delivered.includes("read-only exploration agent")) process.exit(93);
if (!readOnly) writeFileSync(join(process.cwd(), `write-attempt-${process.env.ABOARD_AGENT_ID}.txt`), "the session changed the checkout\n", "utf8");

const script = join(process.env.ABOARD_RUNTIME_ROOT, "agents", process.env.ABOARD_AGENT_ID, "scripts", "abd_hook.py");
function hook(route, payload) {
  const result = spawnSync("uv", ["run", "--no-project", "--no-managed-python", script, route], {
    input: JSON.stringify({ ...payload, session_id: actualSessionId }),
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(92);
  return result.stdout;
}

const implementer = process.env.ABOARD_AGENT_TYPE === "implementer";
const reviewer = process.env.ABOARD_AGENT_TYPE === "reviewer";
if (implementer || reviewer) {
  const invocation = implementer ? "$implement " : "$review-";
  if (resumedSessionId === undefined && !prompt.startsWith(invocation)) process.exit(94);
  if (!process.argv.includes('web_search="disabled"') || !process.argv.includes("features.multi_agent=false")) process.exit(95);
  const decide = (payload) => {
    const output = hook("worker-guard", payload);
    return output.trim().length === 0 ? undefined : JSON.parse(output).hookSpecificOutput.permissionDecision;
  };
  const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  if (decide(bash("git commit -m 'deterministic'")) !== "deny") process.exit(96);
  if (decide(bash("gh pr create --fill")) !== "deny") process.exit(96);
  if (decide({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {} }) !== "deny") process.exit(96);
  if (decide(bash("git status --short")) !== undefined) process.exit(97);
  if (delivered.includes("with Chrome") && !delivered.includes("Chrome browser backend")) process.exit(98);
}

hook("session-start", { hook_event_name: "SessionStart", source: resumedSessionId === undefined ? "startup" : "resume" });
if (delivered.includes("[E2E:chatgpt-process-failure]")) process.exit(23);

function finalMessage() {
  if (readOnly) return "Explore report: the deterministic checkout keeps its launch plan in src/chatgpt/launch.ts.";
  if (implementer) return "Implemented the deterministic issue; the work is uncommitted.";
  if (!reviewer) return "Deterministic ChatGPT session completed.";
  return delivered.includes("[E2E:chatgpt-review-changes]")
    ? "Review complete: requested changes before this can merge."
    : "Review complete: the implementation matches the frozen issue contract.";
}

hook("worker-stop", {
  hook_event_name: "Stop",
  cwd: process.cwd(),
  last_assistant_message: finalMessage(),
});
hook("session-end", { hook_event_name: "SessionEnd", reason: "other" });
