import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { skillCommand } from "../../core/on-demand.js";
import type { PiRun } from "../../core/pi.js";
import { configuredWebhookUrl } from "../report-gotchas/live-config.js";
import { startDiscordFixture } from "./discord.js";
import { LONG_REPORT, REPORT, marker, gotchasScenario } from "./scenario.js";

const TOOL = "report-gotchas";
const success = (run: PiRun) => {
  assert.equal(run.status, "success");
  assert.equal(run.toolExecutions[0]?.isError, false);
  const output = run.events.filter(event => event.type === "tool_execution_end").map(event => JSON.stringify(event.result)).join("\n");
  assert.ok(output.includes("Report successfully posted to Discord."));
};

export async function runPiGotchasJourney(scope: "project" | "user", mode: "json" | "rpc", live = false) {
  const url = live ? await configuredWebhookUrl() : undefined;
  const root = await findHarnessRoot();
  const cli = await skillCommand(join(root, "harness/productivity/report-gotchas/SKILL.md"), "harness-report-gotchas");
  const fixture = await createPiFixture(gotchasScenario(cli.shell));
  let discord: Awaited<ReturnType<typeof startDiscordFixture>> | undefined;
  try {
    if (!live) discord = await startDiscordFixture(fixture.root);
    const project = fixture.workspace.projectRoot;
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    const pathKey = Object.keys(fixture.workspace.env).find(key => key.toLowerCase() === "path") ?? "PATH";
    fixture.workspace.env[pathKey] = bin + delimiter + (fixture.workspace.env[pathKey] ?? "");
    Object.assign(fixture.workspace.env, {
      UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      UV_CACHE_DIR: join(fixture.root, "uv-cache"),
      UV_PYTHON: join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1",
      HARNESS_REPORT_GOTCHAS_STATE_DIR: join(fixture.root, "reporting-state"),
    });
    const state = fixture.workspace.env.HARNESS_REPORT_GOTCHAS_STATE_DIR!;
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const skill = join(platform, "skills", TOOL, "SKILL.md");
    const settingsPath = join(project, ".pi/settings.json");
    const configuration = JSON.parse(await readFile(settingsPath, "utf8"));
    configuration.defaultTools = ["read", "write", "edit", "bash", "powershell"];
    await writeFile(settingsPath, JSON.stringify(configuration, null, 2) + "\n");
    const settings = await readFile(settingsPath, "utf8");
    const install = { scope, pinnedRuntimes: false } as const;
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { ...install, dryRun: true });
    await assert.rejects(access(skill));
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], install);
    await access(skill);
    await assert.rejects(access(join(project, ".git")));
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-pi-transport")));
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-report-gotchas/extensions")));
    // Fetch/build the shipped pin before enabling the Discord-only HTTPS proxy.
    await promisify(execFile)(cli.file, [...cli.args, "--help"], { cwd: project, env: fixture.workspace.env, windowsHide: true, timeout: 90_000 });
    await assert.rejects(access(join(bin, process.platform === "win32" ? "harness-report-gotchas.exe" : "harness-report-gotchas")));
    Object.assign(fixture.workspace.env, discord?.env);
    if (live) fixture.workspace.env.HARNESS_REPORT_GOTCHAS_WEBHOOK_URL = url!;
    const rpc = fixture.rpc();
    if (mode === "json") await rpc.close();
    const prompt = (route: string) => mode === "rpc"
      ? rpc.prompt(`/skill:report-gotchas ${marker(route)}`)
      : fixture.runJson({ prompt: `/skill:report-gotchas ${marker(route)}` });
    let requests = 0;
    if (!live) {
      const missing = await prompt("submit"); requests += 2;
      assert.equal(missing.status, "success"); assert.equal(missing.toolExecutions[0]?.isError, true);
      assert.equal(discord!.attempts, 0);
      await assert.rejects(access(state));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cli.file, [...cli.args, "configure"], { cwd: project, env: fixture.workspace.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => { child.kill(); reject(new Error("Discord configuration timed out")); }, 10_000);
        child.on("error", () => { clearTimeout(timer); reject(new Error("Discord configuration could not start")); });
        child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Discord configuration failed")); });
        child.stdin!.on("error", () => {}); child.stdin!.end(discord!.url);
      });
      const empty = await prompt("empty"); requests += 2;
      assert.equal(empty.status, "success"); assert.equal(empty.toolExecutions[0]?.isError, true);
      assert.equal(discord!.attempts, 0);
    }
    const started = Date.now();
    success(await prompt("submit")); requests += 2;
    const elapsedMs = Date.now() - started;
    if (discord) {
      assert.equal(discord.accepted.length, 1);
      assert.ok(discord.accepted[0]!.content === REPORT, "Discord report differs from the submitted Markdown");
      assert.deepEqual(discord.accepted[0]!.allowed_mentions, { parse: [] });
      discord.rateLimitOnce();
      const limited = await prompt("submit"); requests += 2;
      assert.equal(limited.toolExecutions[0]?.isError, true);
      assert.equal(discord.accepted.length, 1); assert.equal(discord.attempts, 2);
      success(await prompt("long")); requests += 2;
      const parts = discord.accepted.slice(1);
      assert.ok(parts.length >= 2);
      assert.ok(parts.every(part => Buffer.byteLength(part.content, "utf16le") / 2 <= 2000));
      assert.ok(parts.map(part => part.content.replace(/\s/gu, "")).join("") === LONG_REPORT.replace(/\s/gu, ""), "Multipart delivery changed report content");
      const beforePartial = discord.accepted.length;
      discord.failAfter(beforePartial + 1);
      const partial = await prompt("long"); requests += 2;
      assert.equal(partial.toolExecutions[0]?.isError, true);
      assert.equal(discord.accepted.length, beforePartial + 1);
      discord.failAfter(discord.accepted.length);
      const rejected = await prompt("submit"); requests += 2;
      assert.equal(rejected.toolExecutions[0]?.isError, true);
      assert.deepEqual(await readdir(state), ["config.json"]);
      assert.equal(discord.unexpected, 0);
    } else await assert.rejects(access(state));
    assert.equal((await prompt("none")).status, "success"); requests++;
    await rpc.close();
    await runFixtureInstaller(fixture.workspace, "uninstall", [TOOL], install);
    await assert.rejects(access(skill));
    await assert.rejects(access(join(bin, process.platform === "win32" ? "harness-report-gotchas.exe" : "harness-report-gotchas")));
    assert.equal(await readFile(settingsPath, "utf8"), settings);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    assert.equal(fixture.assertions().inferenceRequests, requests);
    return { scope, mode, live, version: fixture.version, inferenceRequests: requests, elapsedMs };
  } finally {
    try { await discord?.close(); } finally { await fixture.close(); }
  }
}
