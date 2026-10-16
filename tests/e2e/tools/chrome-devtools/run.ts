import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

const exec = promisify(execFile);
export async function runChromeDevtoolsJourney(scope: "project" | "user") {
  let scenario: ReturnType<typeof createPiToolScenario>;
  const fixture = await createPiFixture({ scenarioCatalogHash: "chrome-devtools-v1", transition: (request) => scenario.transition(request) });
  const web = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Harness browser fixture</title><h1 id="count">Count: 0</h1><button onclick="document.querySelector(\'#count\').textContent=\'Count: 1\'">Increment</button>');
  });
  try {
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    const address = web.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}/`;
    const root = await findHarnessRoot();
    const { workspace } = fixture;
    const prefix = join(fixture.root, "npm-prefix");
    const runtime = join(fixture.root, "browser-runtime");
    await mkdir(runtime);
    Object.assign(workspace.env, {
      NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_CACHE: join(fixture.root, "npm-cache"),
      NPM_CONFIG_UPDATE_NOTIFIER: "false", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", CD4A_INTERNAL_DAEMON_SESSION_ID: randomUUID(), XDG_RUNTIME_DIR: runtime,
    });
    const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
    const pathKey = Object.keys(workspace.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    workspace.env[pathKey] = `${bin}${delimiter}${workspace.env[pathKey] ?? ""}`;
    const packageRoot = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "chrome-devtools-mcp");
    const cli = join(packageRoot, "build/src/bin/chrome-devtools.js");
    const resources = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const skill = join(resources, "skills/chrome-devtools-cli/SKILL.md");
    await runFixtureInstaller(workspace, "install", ["chrome-devtools"], { scope, dryRun: true });
    await assert.rejects(access(cli), { code: "ENOENT" });
    await assert.rejects(access(skill), { code: "ENOENT" });
    await runFixtureInstaller(workspace, "install", ["chrome-devtools"], { scope });
    assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "1.11.0");
    assert.deepEqual(await readFile(skill), await readFile(join(packageRoot, "skills/chrome-devtools-cli/SKILL.md")));
    const repeat = await runFixtureInstaller(workspace, "install", ["chrome-devtools"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    const shell = process.platform === "win32" ? "powershell" : "bash";
    const settingsPath = join(workspace.projectRoot, ".pi/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...settings, defaultTools: ["read", "write", "edit", shell] }));
    const helper = join(workspace.projectRoot, "browser-check.cjs");
    await copyFile(join(root, "tests/e2e/tools/chrome-devtools/browser-check.cjs"), helper);
    const quote = (value: string) => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
    const command = `${process.platform === "win32" ? "& " : ""}${[process.execPath, helper, cli, origin, fixture.root].map(quote).join(" ")}`;
    scenario = createPiToolScenario({
      name: "chrome-devtools", marker: "[E2E:chrome-devtools]", steps: [
        { checkpoint: "reference", tool: "read", input: { path: join(resources, "skills/chrome-devtools-cli/references/installation.md") } },
        { checkpoint: "browser", tool: shell, input: { command, timeout: 120 } },
      ],
    });
    const rpc = fixture.rpc({ timeoutMs: 180_000 });
    const discovery = await rpc.request("get_commands");
    assert.ok((discovery.data as { commands: { name: string }[] }).commands.some((item) => item.name === "skill:chrome-devtools-cli"));
    const result = await rpc.prompt("/skill:chrome-devtools-cli [E2E:chrome-devtools]", 180_000);
    assert.equal(result.status, "success");
    assert.deepEqual(result.toolExecutions.map(({ name, isError }) => [name, isError]), [["read", false], [shell, false]]);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "browser-result.json"), "utf8")), { count: 1, screenshot: true });
    await rpc.close();
    await runFixtureInstaller(workspace, "install", ["chrome-devtools"], { scope, platform: "chatgpt" });
    await runFixtureInstaller(workspace, "uninstall", ["chrome-devtools"], { scope });
    await access(cli);
    await assert.rejects(access(skill), { code: "ENOENT" });
    await runFixtureInstaller(workspace, "uninstall", ["chrome-devtools"], { scope, platform: "chatgpt" });
    await assert.rejects(access(cli), { code: "ENOENT" });
    const assertions = fixture.assertions();
    assert.equal(assertions.inferenceRequests, 3);
    assert.equal(assertions.unexpectedRequests, 0);
    return { scope, requests: assertions.inferenceRequests, version: fixture.version };
  } finally {
    // Stop only this fixture's uniquely scoped daemon, even when a prior assertion failed.
    const cli = join(fixture.root, "npm-prefix", ...(process.platform === "win32" ? [] : ["lib"]), "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools.js");
    try { await exec(process.execPath, [cli, "stop"], { env: fixture.workspace.env, windowsHide: true, timeout: 10_000 }); } catch { }
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await fixture.close();
  }
}
