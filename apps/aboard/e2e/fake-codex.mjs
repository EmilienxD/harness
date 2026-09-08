import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli e2e\n");
  process.exit(0);
}

const actualSessionId = "af817a6c-cd41-41e2-a4db-44d3f43cd560";
const prompt = process.argv.at(-1) ?? "";
const reference = /@([^;]+);/u.exec(prompt)?.[1];
const delivered = reference === undefined ? prompt : readFileSync(reference, "utf8");
if (!delivered.includes("[E2E:chatgpt-")) process.exit(91);

const script = join(process.env.ABOARD_RUNTIME_ROOT, "agents", process.env.ABOARD_AGENT_ID, "scripts", "abd_hook.py");
function hook(route, payload) {
  const result = spawnSync("uv", ["run", "--no-project", "--no-managed-python", script, route], {
    input: JSON.stringify({ ...payload, session_id: actualSessionId }),
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(92);
}

hook("session-start", { hook_event_name: "SessionStart", source: "startup" });
if (delivered.includes("[E2E:chatgpt-process-failure]")) process.exit(23);
hook("worker-stop", {
  hook_event_name: "Stop",
  cwd: process.cwd(),
  last_assistant_message: "Deterministic ChatGPT session completed.",
});
hook("session-end", { hook_event_name: "SessionEnd", reason: "other" });
