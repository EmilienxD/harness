import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { prepareCodexHome, validateCodexCli } from "../core/codex.js";
import { findHarnessRoot, runFixtureInstaller } from "../core/installer.js";
import { spawnableCommand } from "../core/path.js";
import { createPiFixture } from "../core/pi-fixture.js";
import { childAnswer, parentDone, parentMarker, subagentsScenario } from "../tools/pi-subagents/scenario.js";
import { killProcessTree } from "../tools/subagents/run.js";

const execFileAsync = promisify(execFile);

test("a real headless Pi parent receives its Codex child's result after SessionEnd", { timeout: 240_000 }, async () => {
  await validateCodexCli();
  const root = await findHarnessRoot();
  const fixture = await createPiFixture(subagentsScenario({ explicitModel: true, childProvider: "chatgpt" }));
  const { projectRoot: project, env, agentDir, sessionsDir } = fixture.workspace;
  const bin = join(fixture.root, "uv-bin");
  const toolRoot = join(fixture.root, "uv-tools");
  const python = join(toolRoot, "harness-subagents-runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const stateDir = env.HARNESS_STATE_DIR!;
  const captures = join(fixture.root, "cli-status");
  const database = join(stateDir, "sessions.sqlite3");
  const parentId = randomUUID();
  try {
    const settingsPath = join(project, ".pi", "settings.json");
    const piSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    piSettings.defaultTools.push(process.platform === "win32" ? "powershell" : "bash");
    await writeFile(settingsPath, JSON.stringify(piSettings));
    await mkdir(bin);
    Object.assign(env, { UV_TOOL_DIR: toolRoot, UV_TOOL_BIN_DIR: bin, UV_PYTHON: join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), UV_PYTHON_DOWNLOADS: "never", PYTHONIOENCODING: "utf-8" });
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ""}`;
    for (const platform of ["pi", "chatgpt"] as const) {
      await runFixtureInstaller(fixture.workspace, "install", ["subagents"], { platform, catalogueRoot: root, pinnedRuntimes: false });
    }
    const models = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"));
    const provider = Object.values(models.providers)[0] as { baseUrl: string };
    env.CODEX_HOME = await prepareCodexHome({ root: fixture.root, baseUrl: provider.baseUrl, model: "gpt-6.1-sol", trustedProjects: [project], extraConfig: ["[features]", "hooks = true"] });
    Object.assign(env, { HARNESS_E2E_OPENAI_KEY: env.HARNESS_E2E_PI_KEY, HARNESS_E2E_CLI_DIR: captures, HARNESS_E2E_CHILD_COMPLETE: childAnswer("auto") });
    const hooksPath = join(project, ".codex", "hooks.json");
    const settings = JSON.parse(await readFile(hooksPath, "utf8"));
    const hook = join(root, "tests", "e2e", "tools", "subagents", "shutdown-hook.py");
    for (const groups of Object.values(settings.hooks) as { hooks: { command: string }[] }[][]) {
      for (const group of groups) {
        for (const entry of group.hooks) {
          if (entry.command === "harness-subagents-hook --chatgpt") entry.command = `${python} ${hook}`;
        }
      }
    }
    await writeFile(hooksPath, JSON.stringify(settings));
    const native = spawnableCommand("codex", []);
    await mkdir(join(project, ".harness"), { recursive: true });
    await writeFile(join(project, ".harness", "config.json"), JSON.stringify({ version: 1, providers: { chatgpt: { command: [process.execPath, join(root, "tests", "e2e", "dist", "tools", "subagents", "cli-bridge.js"), "--provider", "chatgpt", native.file, ...native.args] } } }));

    const parent = await fixture.runJson({ prompt: `/skill:subagents-toolkit ${parentMarker("auto")}`, sessionId: parentId, timeoutMs: 180_000 });
    assert.equal(parent.status, "success", JSON.stringify({ stops: parent.assistantStopReasons, tools: parent.toolExecutions, observations: fixture.assertions().observations }));
    const final = parent.events.filter((event) => event.type === "message_end").map((event) => event.message as { role: string; content: { type: string; text?: string }[] }).filter((message) => message.role === "assistant").at(-1);
    assert.equal(final?.content.filter((block) => block.type === "text").map((block) => block.text).join(""), parentDone("auto"));
    const { stdout } = await execFileAsync(python, ["-c", [
      "import json, sqlite3, sys",
      "db=sqlite3.connect(sys.argv[1])",
      "rows=db.execute('SELECT r.state,r.reply,r.acknowledged_at IS NOT NULL,r.delivery_id,s.provider_session_id,s.model,s.effort,r.provider,e.exit_code,e.state FROM requests r JOIN sessions s ON s.id=r.child_session_id JOIN executions e ON e.request_id=r.id').fetchall()",
      "print(json.dumps(rows))",
    ].join("\n"), database], { env, windowsHide: true, timeout: 15_000 });
    const requests = JSON.parse(stdout);
    assert.equal(requests.length, 1);
    const [state, reply, acknowledged, deliveryId, childId, model, effort, childProvider, exitCode, executionState] = requests[0];
    assert.equal(state, "succeeded");
    assert.equal(reply, childAnswer("auto"));
    assert.equal(acknowledged, 1);
    assert.equal(model, "gpt-6.1-sol");
    assert.equal(effort, "medium");
    assert.equal(childProvider, "chatgpt");
    assert.equal(exitCode, 0);
    assert.equal(executionState, "exited");
    const receipts = (await readdir(captures)).filter((name) => name.startsWith("shutdown-"));
    assert.equal(receipts.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(captures, receipts[0]!), "utf8")), { state: "pending", hasReply: false });
    const session = (await readdir(sessionsDir)).find((name) => name.endsWith(`_${parentId}.jsonl`));
    assert.ok(session);
    const entries = (await readFile(join(sessionsDir, session), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const deliveries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "harness-subagents-result");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].details.deliveryId, deliveryId);
    assert.ok((await readdir(join(env.CODEX_HOME!, "sessions"), { recursive: true })).some((name) => name.endsWith(`${childId}.jsonl`)));
    assert.equal((await readdir(join(stateDir, "inboxes"), { recursive: true })).filter((name) => /\.md(?:\.running)?$/u.test(name)).length, 0);
    assert.equal(fixture.assertions().inferenceRequests, 5);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally {
    try {
      const { stdout } = await execFileAsync(python, ["-c", "import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps([r[0] for r in db.execute(\"SELECT supervisor_pid FROM executions WHERE state IN ('starting','running','uncertain') AND supervisor_pid IS NOT NULL\")]))", database], { env, windowsHide: true, timeout: 10_000 }).catch(() => ({ stdout: "[]" }));
      for (const pid of JSON.parse(stdout) as number[]) await killProcessTree(pid, true);
    } finally { await fixture.close(); }
  }
});
