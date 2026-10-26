import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { skillCommand } from "../../core/on-demand.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { containsPath, spawnableCommand } from "../../core/path.js";
import { preparePiWorkspace } from "../../core/pi.js";
import { createFakeGh } from "../issues/support.js";
import { helpersScenario, MARKER, scenarioCatalogHash } from "./scenario.js";

const exec = promisify(execFile);

export async function runShipHelpersJourney() {
  await validateCodexCli();
  const root = await mkdtemp(join(tmpdir(), "harness-ship-helpers-e2e-"));
  let server: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const harness = await findHarnessRoot();
    const python = join(harness, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const commands: string[] = [];
    server = await startFakeOpenAiServer({ scenarioCatalogHash, transition: helpersScenario(commands), diagnosticsPath: join(root, "structural-diagnostics.json") });
    // Reuse the shared isolated home/environment without launching Pi.
    const workspace = await preparePiWorkspace(root, server.baseUrl, server.authToken);
    const gh = await createFakeGh(root);
    const bin = join(root, "uv-bin");
    await mkdir(bin);
    const env = workspace.env;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [gh.bin, bin, env[pathKey]].join(delimiter);
    Object.assign(env, { UV_TOOL_DIR: join(root, "uv-tools"), UV_TOOL_BIN_DIR: bin, UV_CACHE_DIR: join(root, "uv-cache"), UV_PYTHON: python, UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1",
      PYTHONPATH: gh.bin, HARNESS_E2E_NODE: process.execPath, HARNESS_E2E_FAKE_GH: join(gh.bin, "fake-gh.cjs") });
    const project = workspace.projectRoot;
    const command = async (name: string, args: readonly string[]) => {
      const executable = spawnableCommand(name, args);
      return (await exec(executable.file, [...executable.args], { cwd: project, env, windowsHide: true, timeout: 90_000 })).stdout.trim();
    };
    await command("git", ["init", "--quiet"]);
    await command("git", ["config", "user.name", "Helper fixture"]);
    await command("git", ["config", "user.email", "helpers@example.invalid"]);
    await writeFile(join(project, "main.py"), "VALUE = 42\n");
    await command("git", ["add", "main.py"]);
    await command("git", ["commit", "--quiet", "-m", "Base"]);
    const base = await command("git", ["rev-parse", "HEAD"]);
    await mkdir(join(project, "tests/unit"), { recursive: true });
    const testPath = join(project, "tests/unit/test_value.py");
    const stub = 'def test_value():\n    """The delivered value is available."""\n    assert False\n';
    const implementation = stub.replace("assert False", "assert 42 == 42");
    await writeFile(testPath, stub);
    await command("git", ["add", "tests"]);
    await command("git", ["commit", "--quiet", "-m", "Criteria"]);
    const anchor = await command("git", ["rev-parse", "HEAD"]);
    await runFixtureInstaller(workspace, "install", ["ship"], { platform: "chatgpt", pinnedRuntimes: false });
    const skill = join(project, ".agents/skills/ship/SKILL.md");
    const issue = await skillCommand(skill, "issue-context");
    const stubs = await skillCommand(skill, "ship-stubs");
    // Fetch the actual immutable packages before asking the provider to run their behavior.
    for (const cli of [issue, stubs]) await command(cli.file, [...cli.args, "--help"]);
    const graph = { data: { repository: { issue: { id: "fixture-42", number: 42, title: "Fixture", body: "Requirements from fixture", state: "OPEN", repository: { nameWithOwner: "fixture/issues" }, labels: { nodes: [] }, comments: { nodes: [] }, subIssues: { nodes: [] }, blockedBy: { nodes: [] }, blocking: { nodes: [] }, timelineItems: { nodes: [] } } } } };
    await writeFile(join(gh.bin, "fake-gh.cjs"), `const fs = require('node:fs'); const args = process.argv.slice(2); if (args[0] !== 'api' || args[1] !== 'graphql') process.exit(2); fs.writeFileSync(${JSON.stringify(join(root, "gh-read.json"))}, JSON.stringify(args)); console.log(${JSON.stringify(JSON.stringify(graph))});\n`);
    await writeFile(join(root, "implement.py"), `from pathlib import Path\nPath(${JSON.stringify(testPath)}).write_text(${JSON.stringify(implementation)}, encoding="utf-8", newline="")\nprint("implementation written")\n`);
    const check = `${stubs.shell} check --base ${base} --anchor ${anchor}`;
    const quote = (value: string) => `'${value.replaceAll("'", process.platform === "win32" ? "''" : `'"'"'`)}'`;
    commands.push(`${issue.shell} 42 --repo fixture/issues`, check, `${process.platform === "win32" ? "& " : ""}${quote(python)} ${quote(join(root, "implement.py"))}`, check);
    const home = await prepareCodexHome({ root, baseUrl: server.baseUrl, trustedProjects: [project] });
    Object.assign(env, { CODEX_HOME: home, HARNESS_E2E_OPENAI_KEY: server.authToken });
    const run = await runCodex(["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--dangerously-bypass-hook-trust", `${MARKER} Verify issue context and stub completion using the installed ship skill.`], project, env);
    assert.equal(run.timedOut, false);
    assert.equal(run.code, 0, "Codex helper journey failed; inspect structural assertions");
    assert.equal(await readFile(testPath, "utf8"), implementation);
    assert.ok(JSON.parse(await readFile(join(root, "gh-read.json"), "utf8")).includes("graphql"));
    for (const name of ["issue-context", "ship-stubs", "test-workflows"]) await assert.rejects(access(join(bin, name + (process.platform === "win32" ? ".exe" : ""))));
    const inventory = await command("uv", ["tool", "list"]);
    assert.match(inventory, /^harness-subagents-runtime /mu);
    assert.doesNotMatch(inventory, /^harness-(?:issue-context|ship-contract|test-workflows) /mu);
    const assertions = server.assertions();
    assert.equal(assertions.inferenceRequests, 5);
    assert.equal(assertions.unexpectedRequests, 0);
    assert.deepEqual(assertions.checkpoints, ["issue-context", "stub-rejected", "implementation", "stub-accepted", "complete"]);
    await runFixtureInstaller(workspace, "uninstall", ["ship"], { platform: "chatgpt" });
    await assert.rejects(access(skill));
    return { inferenceRequests: assertions.inferenceRequests, unexpectedRequests: assertions.unexpectedRequests };
  } finally {
    await server?.close();
    if (!containsPath(tmpdir(), root) || root === tmpdir()) throw new Error("Helper fixture cleanup escaped its temporary root");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
