import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { findFinalText, parseStreamJson, runClaude, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { containsPath } from "../../core/path.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { configuredWebhookUrl } from "./live-config.js";
import { claudeTransition, codexTransition, MARKER, REPORT_MARKER, scenarioCatalogHash } from "./scenario.js";

export async function runReportGotchasJourney(platform: "claude" | "chatgpt") {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const webhookUrl = await configuredWebhookUrl();
  const root = await mkdtemp(join(tmpdir(), `harness-report-gotchas-${platform}-e2e-`));
  let server: Awaited<ReturnType<typeof startFakeAnthropicServer>> | Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const projectRoot = join(root, "project");
    const home = join(root, "home");
    const bin = join(root, "bin");
    for (const path of [projectRoot, home, bin]) await mkdir(path);
    const env: NodeJS.ProcessEnv = {};
    const allowed = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "programfiles", "programfiles(x86)", "programw6432", "lang", "lc_all", "term"]);
    for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
    const harnessRoot = await findHarnessRoot();
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
      UV_TOOL_DIR: join(root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      UV_PYTHON: join(harnessRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1", HARNESS_STATE_DIR: join(root, "installer-state"),
      HARNESS_REPORT_GOTCHAS_STATE_DIR: join(root, "reporting-state"), HARNESS_REPORT_GOTCHAS_WEBHOOK_URL: webhookUrl,
      NO_PROXY: "127.0.0.1,localhost",
    });
    const workspace = { projectRoot, agentDir: join(root, "agent"), sessionsDir: join(root, "sessions"), env };
    const install = { platform, pinnedRuntimes: false } as const;
    await runFixtureInstaller(workspace, "install", ["report-gotchas"], install);
    await assert.rejects(access(join(projectRoot, ".git")));
    const diagnosticsPath = join(root, "structural-diagnostics.json");
    const report = `**${REPORT_MARKER} - ${platform} - ${randomUUID()}**\n\n- End-to-end verification: a real headless agent CLI posted this Unicode \u96ea report using fake model inference. This test message can be deleted.`;
    const command = platform === "chatgpt" && process.platform === "win32"
      ? `harness-report-gotchas submit -m @'\n${report}\n'@`
      : `harness-report-gotchas submit <<'HARNESS_GOTCHAS'\n${report}\nHARNESS_GOTCHAS`;
    const started = Date.now();
    let finalText: string;
    if (platform === "claude") {
      const config = join(root, "claude-config");
      await mkdir(config);
      await writeFile(join(config, "settings.json"), "{}\n");
      server = await startFakeAnthropicServer({ repoRoot: projectRoot, diagnosticsPath, scenarioCatalogHash,
        parseRequest: parseAnthropicMessagesRequest, transition: request => claudeTransition(request, command) });
      Object.assign(env, {
        ANTHROPIC_BASE_URL: server.baseUrl, ANTHROPIC_AUTH_TOKEN: server.authToken, CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
      });
      const result = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", "Skill,Bash",
        "--allowedTools", "Skill,Bash", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
        "--session-id", randomUUID(), `${MARKER} Report the implementation caveat using the available skill.`], projectRoot, env);
      if (result.timedOut || result.code !== 0) throw new Error("Claude headless Discord journey failed; inspect structural endpoint checkpoints");
      finalText = findFinalText(parseStreamJson(result.stdout), result.stdout);
    } else {
      const skill = join(projectRoot, ".agents/skills/report-gotchas/SKILL.md");
      const read = process.platform === "win32" ? `Get-Content -Raw -LiteralPath '${skill.replaceAll("'", "''")}'` : `cat '${skill.replaceAll("'", `'"'"'`)}'`;
      const endpoint = await startFakeOpenAiServer({ diagnosticsPath, scenarioCatalogHash,
        transition: request => codexTransition(request, read, command) });
      server = endpoint;
      const codexHome = await prepareCodexHome({ root, baseUrl: endpoint.baseUrl, trustedProjects: [projectRoot] });
      Object.assign(env, { CODEX_HOME: codexHome, HARNESS_E2E_OPENAI_KEY: endpoint.authToken });
      const output = join(root, "final.txt");
      const result = await runCodex(["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access",
        "--output-last-message", output, `${MARKER} Report the implementation caveat using the available skill.`], projectRoot, env);
      if (result.timedOut || result.code !== 0) throw new Error("Codex headless Discord journey failed; inspect structural endpoint checkpoints");
      finalText = await readFile(output, "utf8");
    }
    const observations = server.assertions();
    const checkpoints = ["skill-loaded", "report-submitted", "complete"];
    assert.ok(checkpoints.every(checkpoint => observations.checkpoints.includes(checkpoint)));
    assert.equal(observations.inferenceRequests, 3);
    assert.equal(observations.unexpectedRequests, 0);
    await assert.rejects(access(join(root, "reporting-state")));
    await runFixtureInstaller(workspace, "uninstall", ["report-gotchas"], install);
    await assert.rejects(access(join(bin, process.platform === "win32" ? "harness-report-gotchas.exe" : "harness-report-gotchas")));
    return { checkpoints, delivered: true, finalText, unexpectedRequests: observations.unexpectedRequests,
      inferenceRequests: observations.inferenceRequests, elapsedMs: Date.now() - started };
  } finally {
    await server?.close();
    if (!containsPath(tmpdir(), root) || root === tmpdir()) throw new Error("Report fixture cleanup escaped its temporary root");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
