import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { spawnableCommand } from "../../core/path.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import type { PiWorkspace } from "../../core/pi.js";
import { ENGINE_QUERIES, marker, webToolkitScenario } from "./scenario.js";
import { interceptSearch, LONG, startWebFixture } from "./web-fixture.js";

const exec = promisify(execFile);
export async function runPiWebToolkitJourney(scope: "project" | "user", mode: "json" | "rpc") {
  let origin = "";
  const fixture = await createPiFixture(webToolkitScenario(() => origin));
  let web: Awaited<ReturnType<typeof startWebFixture>> | undefined;
  let browser: Awaited<ReturnType<typeof interceptSearch>> | undefined;
  try {
    web = await startWebFixture();
    origin = web.origin;
    const root = await findHarnessRoot();
    const { workspace } = fixture;
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    Object.assign(workspace.env, {
      UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      UV_PYTHON: join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1",
    });
    const pathKey = Object.keys(workspace.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    workspace.env[pathKey] = `${bin}${delimiter}${workspace.env[pathKey] ?? ""}`;
    // Current-user CLI installations remain invisible to the missing-executable check.
    const executable = join(bin, process.platform === "win32" ? "web-toolkit.exe" : "web-toolkit");
    const resources = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const extension = join(resources, "extensions", "harness-web-toolkit", "index.ts");
    const settings = join(workspace.projectRoot, ".pi", "settings.json");
    const settingsBefore = await readFile(settings, "utf8");
    await runFixtureInstaller(workspace, "install", ["web-toolkit"], { scope, dryRun: true });
    assert.equal(await exists(extension), false); assert.equal(await exists(executable), false);
    await runFixtureInstaller(workspace, "install", ["web-toolkit"], { scope });
    assert.equal(await exists(join(resources, "skills", "web-toolkit")), false);
    assert.equal(await readFile(extension, "utf8"), await readFile(join(root, "harness/productivity/web-toolkit/pi/extension.ts"), "utf8"));
    const repeat = await runFixtureInstaller(workspace, "install", ["web-toolkit"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    const python = join(fixture.root, "uv-tools", "harness-web-toolkit", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const endpoint = (await command(python, ["-c", "from web_toolkit.browser import ensure; print(ensure())"], workspace)).trim();
    browser = await interceptSearch(endpoint, origin);

    const rpc = fixture.rpc({ timeoutMs: 120_000 });
    const discovery = await rpc.request("get_commands");
    assert.equal((discovery.data as { commands: { name: string }[] }).commands.some((item) => item.name === "skill:web-toolkit"), false);
    const prompt = marker("main");
    const result = mode === "json" ? await fixture.runJson({ prompt, timeoutMs: 90_000 }) : await rpc.prompt(prompt, 90_000);
    assert.equal(result.status, "success", JSON.stringify({ checkpoints: fixture.assertions().checkpoints, tools: result.toolExecutions }));
    assert.deepEqual(result.toolExecutions.map(({ name, isError }) => [name, isError]), [
      ["web_search", false], ["web_search", false], ["web_search", false], ["web_search", false],
      ["web_fetch", false], ["web_fetch", false], ["web_fetch", false],
      ["web_fetch", true], ["web_search", true], ["web_fetch", true],
      ["web_search", true], ["web_search", true],
    ]);
    const ends = result.events.filter((event) => event.type === "tool_execution_end");
    for (const event of ends.slice(0, 8)) {
      const value = event.result as { structuredContent: { output: string; exitCode: number }; details: unknown };
      assert.equal(typeof value.structuredContent.output, "string");
      assert.equal(value.structuredContent.exitCode, event === ends[7] ? 1 : 0);
      assert.ok(JSON.stringify(value.structuredContent) === JSON.stringify(value.details));
    }
    const pages = join(workspace.env.HARNESS_STATE_DIR!, "web-toolkit", "pages");
    const files = await readdir(pages); assert.equal(files.length, 1);
    assert.equal(await readFile(join(pages, files[0]!), "utf8"), LONG);
    assert.deepEqual(web.requests, ["/page", "/redirect", "/page", "/long", "/missing"]);
    assert.equal(await exists(join(workspace.projectRoot, "injected")), false);
    assert.equal(browser.assertions(ENGINE_QUERIES).searches, 4);

    // Break the actual CLI, preserving the installed extension; a real missing executable is a tool error.
    const originalPath = workspace.env[pathKey];
    workspace.env[pathKey] = bin;
    await rename(executable, `${executable}.disabled`);
    try {
      const missing = await fixture.runJson({ prompt: marker("missing") });
      assert.equal(missing.status, "success"); assert.equal(missing.toolExecutions[0]?.isError, true);
      const failure = missing.events.find((event) => event.type === "tool_execution_end")?.result as { content?: { type: string; text?: string }[] };
      const output = (failure.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").replace(/\r\n/gu, "\n");
      const install = /^uv tool install --force "([^"\r\n]+)"$/mu.exec(output);
      assert.ok(install, "Missing executable result must supply a runnable installation command");
      // Run the advertised command against an empty offline cache, outside personal uv state.
      const recovery = spawnableCommand("uv", ["tool", "install", "--force", install[1]!]);
      let installationFailed = false;
      try {
        await exec(recovery.file, [...recovery.args], { cwd: workspace.projectRoot,
          env: { ...workspace.env, UV_OFFLINE: "1", UV_CACHE_DIR: join(fixture.root, "recovery-cache") },
          windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      } catch (error) { installationFailed = typeof (error as { code?: unknown }).code === "number"; }
      assert.ok(installationFailed, "Advertised installation must fail cleanly without network or a populated cache");
      assert.equal(missing.toolExecutions.length, 1);
      assert.equal(await exists(executable), false);
    } finally { await rename(`${executable}.disabled`, executable); workspace.env[pathKey] = originalPath; }

    const cancellation = rpc.prompt(marker("abort"));
    await deadline(web.slow, "Web fetch did not reach cancellation checkpoint");
    const abort = await rpc.request("abort"); assert.equal(abort.success, true);
    const cancelled = await cancellation;
    // Pi 1.2.0 can emit an assistant error after aborting a tool; inspect settlement and effects.
    assert.ok(cancelled.events.some((event) => event.type === "agent_settled" && event.aborted === true));
    assert.deepEqual(cancelled.toolExecutions, [{ name: "web_fetch", isError: true }]);
    await deadline(web.disconnected, "Cancelled CLI left its HTTP request alive");
    await rpc.close();
    const observations = fixture.assertions();
    assert.equal(observations.inferenceRequests, 16); assert.equal(observations.unexpectedRequests, 0);
    await browser.close(); browser = undefined;
    await runFixtureInstaller(workspace, "uninstall", ["web-toolkit"], { scope });
    assert.equal(await exists(extension), false); assert.equal(await exists(executable), false);
    assert.equal(await exists(join(resources, "skills", "web-toolkit")), false);
    assert.equal(await readFile(settings, "utf8"), settingsBefore);
    return { scope, mode, version: fixture.version, inferenceRequests: observations.inferenceRequests, unexpectedRequests: observations.unexpectedRequests,
      checkpoints: observations.checkpoints, nativeTools: 2, preservedLongPage: true, cancelled: true, removed: true };
  } finally {
    try { await browser?.close(); } finally {
      try { await web?.close(); } finally { await fixture.close(); }
    }
  }
}
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function deadline(promise: Promise<void>, message: string) {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15_000); })]); }
  finally { clearTimeout(timer); }
}
async function command(name: string, args: string[], workspace: PiWorkspace) {
  const command = spawnableCommand(name, args);
  try { return (await exec(command.file, [...command.args], { cwd: workspace.projectRoot, env: workspace.env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new Error("Web Toolkit fixture process failed"); }
}
