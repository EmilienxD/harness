import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { spawnableCommand } from "../../core/path.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { skillCommand } from "../../core/on-demand.js";
import { ACCEPTANCE, MARKER, REGRESSION, SOURCE, WORKFLOW, testWorkflowsScenario } from "./scenario.js";

const execFileAsync = promisify(execFile);
const TOOL = "test-workflows";

export async function runPiTestWorkflowsJourney(scope: "project" | "user", mode: "json" | "rpc") {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const root = await findHarnessRoot();
  const cli = await skillCommand(join(root, "harness/building/test-workflows/SKILL.md"), TOOL);
  const fixture = await createPiFixture(testWorkflowsScenario(shell, cli.shell));
  try {
    const project = fixture.workspace.projectRoot;
    // Both uv's disposable environments and host-tool inventory stay fixture-owned.
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    Object.assign(fixture.workspace.env, {
      UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      UV_CACHE_DIR: join(fixture.root, "uv-cache"),
      UV_PYTHON: join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1",
    });
    const pathKey = Object.keys(fixture.workspace.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    fixture.workspace.env[pathKey] = `${bin}${delimiter}${fixture.workspace.env[pathKey] ?? ""}`;
    const settingsFile = join(project, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
    settings.defaultTools = ["read", "write", "edit", shell];
    await writeFile(settingsFile, `${JSON.stringify(settings)}\n`);
    const settingsBefore = await readFile(settingsFile, "utf8");
    await mkdir(join(project, "src"));
    await mkdir(join(project, "checks"));
    await writeFile(join(project, "src", "greet.cjs"), SOURCE);
    await writeFile(join(project, "checks", "greeting.md"), WORKFLOW);
    await writeFile(join(project, "accept.cjs"), ACCEPTANCE);
    await command("git", ["init", "--quiet"], fixture.workspace);

    const skillFile = join(scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir, "skills", TOOL, "SKILL.md");
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope, dryRun: true });
    assert.equal(await exists(skillFile), false);
    assert.equal(await exists(join(fixture.root, "uv-tools", "harness-test-workflows")), false);
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    const skillSource = await readFile(join(root, "harness", "building", TOOL, "SKILL.md"), "utf8");
    assert.equal(await readFile(skillFile, "utf8"), skillSource);
    assert.equal((await readdir(join(skillFile, ".."))).join(","), "SKILL.md");
    const repeat = await runFixtureInstaller(fixture.workspace, "install", [TOOL], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    const uvInventory = await command("uv", ["tool", "list"], fixture.workspace);
    assert.doesNotMatch(uvInventory, /^harness-test-workflows /mu);

    const rpc = fixture.rpc({ timeoutMs: 120_000 });
    const discovery = await rpc.request("get_commands");
    const commands = (discovery.data as { commands?: { name: string; source: string; sourceInfo?: { path?: string } }[] }).commands ?? [];
    const skill = commands.find((item) => item.name === `skill:${TOOL}` && item.source === "skill");
    assert.equal(resolve(skill?.sourceInfo?.path ?? ""), resolve(skillFile));
    const prompt = `/skill:${TOOL} Run the greeting workflow and investigate a regression. ${MARKER}`;
    const run = mode === "json" ? await fixture.runJson({ prompt, timeoutMs: 90_000 }) : await rpc.prompt(prompt, 90_000);
    assert.equal(run.status, "success");
    assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "passing-evidence.json"), "utf8")), { passed: true });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "failing-evidence.json"), "utf8")), { passed: false });
    assert.equal(await readFile(join(project, "src", "greet.cjs"), "utf8"), REGRESSION);
    assert.equal(await readFile(join(project, "checks", "greeting.md"), "utf8"), WORKFLOW);
    const manifest = JSON.parse(await readFile(join(project, "checks", "greeting.manifest.json"), "utf8")) as { verified_files: Record<string, string> };
    assert.deepEqual(manifest.verified_files, { "src/greet.cjs": createHash("sha256").update(SOURCE).digest("hex") });
    assert.equal(await exists(join(project, "checks", "broken.manifest.json")), false);
    assert.equal(await exists(join(project, "checks", "invalid.manifest.json")), false);
    const confirmations = run.events.filter((event) => event.type === "tool_execution_start" && typeof event.args === "object" && event.args !== null && "command" in event.args && String(event.args.command).startsWith(`${cli.shell} --json confirm`));
    assert.equal(confirmations.length, 1);
    await rpc.close();

    // Provider skills are independent; neither provider creates a host CLI.
    await runFixtureInstaller(fixture.workspace, "install", [TOOL], { platform: "chatgpt" });
    await runFixtureInstaller(fixture.workspace, "uninstall", [TOOL], { scope });
    assert.equal(await exists(skillFile), false);
    const chatgptSkill = join(project, ".agents", "skills", TOOL, "SKILL.md");
    assert.equal(await readFile(chatgptSkill, "utf8"), skillSource);
    assert.doesNotMatch(await command("uv", ["tool", "list"], fixture.workspace), /^harness-test-workflows /mu);
    await runFixtureInstaller(fixture.workspace, "uninstall", [TOOL], { platform: "chatgpt" });
    assert.doesNotMatch(await command("uv", ["tool", "list"], fixture.workspace), /^harness-test-workflows /mu);
    assert.equal(await readFile(settingsFile, "utf8"), settingsBefore);
    const assertions = fixture.assertions();
    return {
      scope, mode, version: fixture.version, confirmations: confirmations.length,
      inferenceRequests: assertions.inferenceRequests, unexpectedRequests: assertions.unexpectedRequests,
      checkpoints: assertions.checkpoints, toolExecutions: run.toolExecutions.length,
      expectedNonzeroTools: run.toolExecutions.filter((tool) => tool.isError).length,
      noInstalledCli: true, failedRunUnconfirmed: true,
    };
  } finally { await fixture.close(); }
}

async function command(name: string, args: readonly string[], workspace: { projectRoot: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const executable = spawnableCommand(name, args);
  try { return (await execFileAsync(executable.file, [...executable.args], { cwd: workspace.projectRoot, env: workspace.env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new Error(`Pi test-workflows fixture ${name} setup or inventory failed`); }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
