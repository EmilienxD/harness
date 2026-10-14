import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { createFakeGh, initializeRepository } from "../issues/support.js";

const exec = promisify(execFile);
const MARKER = "[E2E:pi-cleanup-git]";
const APPROVAL = "[E2E:pi-cleanup-approved]";

export async function runPiCleanupGit(scope: "project" | "user", mode: "json" | "rpc") {
  const shell = process.platform === "win32" ? "powershell" : "bash";
  let project = "";
  let linked = "";
  let baseline = "";
  let inventoryGithub = "";
  const audit = createPiToolScenario({ name: "pi-cleanup-git", marker: MARKER, steps: [
    { checkpoint: "inspect-checkout", tool: "read", input: { path: "target.txt" } },
    { checkpoint: "inspect-merged-branch", tool: shell, input: { command: "git show-ref --verify refs/heads/merged-delete" } },
  ] });
  const fixture = await createPiFixture({ scenarioCatalogHash: audit.scenarioCatalogHash, transition: (request) => {
    const input = request.input.filter((item) => item.role === "user").map((item) => text(item.content));
    // Consume inventory facts as data. No assertion depends on agent instruction prose.
    const inventories = input.filter((value) => /^inventory_cwd: /m.test(value));
    if (inventories.length) {
      const value = /^inventory_cwd: (.+)$/m.exec(inventories.at(-1)!)?.[1];
      if (!value || resolve(value.startsWith('"') ? JSON.parse(value) as string : value) !== resolve(project)) throw new Error("Pi cleanup inventory selected a foreign checkout");
      if (/^target_oid: (.+)$/m.exec(inventories.at(-1)!)?.[1] !== baseline) throw new Error("Pi cleanup inventory selected an unexpected target snapshot");
      const github = /^github_status: (.+)$/m.exec(inventories.at(-1)!)?.[1];
      inventoryGithub = github ?? "missing";
      if (github !== "collected") throw new Error(`Cleanup GitHub data unavailable: ${github}`);
    } else if (!input.some((value) => value.includes("[E2E:cleanup-unrelated]"))) throw new Error("Pi explicit cleanup has no prepared inventory data");
    for (const marker of ["[E2E:cleanup-unrelated]", "[E2E:cleanup-extension]"]) {
      if (input.some((value) => value.includes(marker))) return createPiToolScenario({ name: "cleanup-input", marker, steps: [] }).transition(request);
    }
    const approved = input.some((value) => value.includes(APPROVAL));
    const removal = shell === "powershell" ? `git worktree remove '${linked.replaceAll("'", "''")}'` : `git worktree remove '${linked.replaceAll("'", `'"'"'`)}'`;
    const scenario = createPiToolScenario({ name: "pi-cleanup-git", marker: MARKER, steps: [
      { checkpoint: "inspect-checkout", tool: "read", input: { path: "target.txt" } },
      { checkpoint: "inspect-merged-branch", tool: shell, input: { command: "git show-ref --verify refs/heads/merged-delete" } },
      { checkpoint: "recheck-live-state", tool: shell, input: { command: "git rev-list --count main..changed-later" }, verifyResult: (output) => {
        if (!/^1\r?$/m.test(text(output))) throw new Error("Cleanup did not observe changed live branch state");
      } },
      { checkpoint: "delete-approved-branch", tool: shell, input: { command: "git branch -d merged-delete" } },
      { checkpoint: "remove-approved-worktree", tool: shell, input: { command: removal } },
      { checkpoint: "delete-approved-worktree-branch", tool: shell, input: { command: "git branch -d cleanup-linked" } },
    ] });
    const response = scenario.transition(request);
    if (!approved && response.checkpoint === "recheck-live-state") return {
      scenario: "pi-cleanup-git", checkpoint: "awaiting-approval", output: { type: "message", id: "msg_cleanup_approval", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Inventory inspected. Approve named cleanup actions before applying them.", annotations: [] }] },
    };
    if (!approved && request.input.filter((item) => item.type === "function_call_output").length > 2) throw new Error("Cleanup mutation history has no explicit approval");
    return response;
  } });
  try {
    project = fixture.workspace.projectRoot;
    linked = join(fixture.root, "linked-cleanup");
    const gh = await createFakeGh(fixture.root);
    await writeFile(join(gh.bin, "fake-gh.cjs"), `const fs = require('node:fs');
const path = ${JSON.stringify(gh.statePath)}; const args = process.argv.slice(2); const state = JSON.parse(fs.readFileSync(path, 'utf8')); state.calls.push(args); fs.writeFileSync(path, JSON.stringify(state));
if (args[0] === 'repo' && args[1] === 'view') console.log('fixture/cleanup');
else if (args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp' && ['repos/fixture/cleanup/pulls?', 'repos/fixture/cleanup/issues?'].some(prefix => (args[3] ?? '').startsWith(prefix))) console.log('[[]]');
else process.exitCode = 2;
`);
    Object.assign(fixture.workspace.env, { PATH: `${gh.bin}${delimiter}${fixture.workspace.env.PATH ?? process.env.PATH ?? ""}`, PYTHONPATH: gh.bin, HARNESS_E2E_NODE: process.execPath, HARNESS_E2E_FAKE_GH: join(gh.bin, "fake-gh.cjs") });
    const git = async (...args: string[]) => (await exec("git", args, { cwd: project, env: fixture.workspace.env, windowsHide: true })).stdout.trim();
    await writeFile(join(project, ".gitignore"), ".pi/\n.harness/\n");
    await writeFile(join(project, "target.txt"), "baseline\n");
    await initializeRepository(project);
    await git("config", "core.autocrlf", "false");
    baseline = await git("rev-parse", "main");
    for (const name of ["merged-delete", "changed-later", "cleanup-linked", "release/keep", "keep-policy"]) await git("branch", name);
    await git("config", "branch.keep-policy.deleteMerged", "false");
    await git("worktree", "add", linked, "cleanup-linked");
    await runFixtureInstaller(fixture.workspace, "install", ["cleanup-git"], { scope });
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const skill = join(platform, "skills", "cleanup-git", "SKILL.md");
    const settingsPath = join(project, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.defaultTools = ["read", "write", "edit", shell];
    // Native manual commands remain callable when interactive skill suggestions are disabled.
    settings.enableSkillCommands = false;
    await writeFile(settingsPath, JSON.stringify(settings));
    await mkdir(join(platform, "extensions"), { recursive: true });
    await writeFile(join(platform, "extensions", "cleanup-route-probe.ts"), `export default function (pi) {
      pi.registerCommand("e2e-cleanup-submit", { handler: () => pi.sendUserMessage("/skill:cleanup-git [E2E:cleanup-extension]", { expandPromptTemplates: true }) });
    }`);
    const rpc = fixture.rpc();
    const discovered = await rpc.request("get_commands");
    const commands = (discovered.data as { commands: { name: string; source: string }[] }).commands;
    assert.ok(commands.some((command) => command.name === "skill:cleanup-git" && command.source === "skill"));
    const before = await git("show-ref", "--heads");
    const worktreesBefore = await git("worktree", "list", "--porcelain");
    const prompt = `${mode === "json" ? "/skill:cleanup-git" : "/cleanup-git"} --dry ${MARKER}`;
    const result = mode === "json" ? await fixture.runJson({ prompt, sessionId: "cleanup-audit" }) : await rpc.prompt(prompt);
    assert.equal(result.status, "success", `GitHub inventory status: ${inventoryGithub}`);
    assert.equal(await git("show-ref", "--heads"), before);
    assert.equal(await git("worktree", "list", "--porcelain"), worktreesBefore);
    assert.equal(fixture.assertions().inferenceRequests, 3);
    // Local work arriving after the report must survive the separately approved cleanup.
    await writeFile(join(project, "target.txt"), "later work\n");
    await git("add", "target.txt"); await git("commit", "-m", "Later work");
    const changed = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/heads/changed-later", changed);
    await git("reset", "--hard", baseline);
    const approval = `Approved: delete merged-delete; remove the linked cleanup worktree and cleanup-linked branch only. Preserve changed-later if live checks show remaining commits. ${APPROVAL}`;
    let cleanup;
    if (mode === "json") {
      const { readdir } = await import("node:fs/promises");
      const session = (await readdir(fixture.workspace.sessionsDir)).find((name) => name.includes("cleanup-audit"));
      assert.ok(session);
      cleanup = await fixture.runJson({ prompt: approval, sessionFile: join(fixture.workspace.sessionsDir, session) });
    } else cleanup = await rpc.prompt(approval);
    assert.equal(cleanup.status, "success");
    assert.equal([...result.toolExecutions, ...cleanup.toolExecutions].some((tool) => tool.isError), false);
    await assert.rejects(git("rev-parse", "--verify", "refs/heads/merged-delete"));
    await assert.rejects(git("rev-parse", "--verify", "refs/heads/cleanup-linked"));
    await assert.rejects(access(linked));
    assert.equal(await git("rev-parse", "changed-later"), changed);
    for (const name of ["main", "release/keep", "keep-policy"]) assert.equal(await git("rev-parse", name), baseline);
    assert.equal(await readFile(join(project, "target.txt"), "utf8"), "baseline\n");
    assert.equal(fixture.assertions().inferenceRequests, 8);
    const calls = (JSON.parse(await readFile(gh.statePath, "utf8")) as { calls: string[][] }).calls;
    assert.equal(calls.length, 8); // repository + six branch PR inventories + open issues
    assert.equal(calls.every((args) => args[0] === "repo" && args[1] === "view" || args[0] === "api" && args.includes("--paginate") && !args.includes("--method")), true);
    assert.equal((await fixture.runJson({ prompt: "[E2E:cleanup-unrelated]" })).status, "success");
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { calls: unknown[] }).calls.length, calls.length);
    const submitted = fixture.rpc();
    assert.equal((await submitted.prompt("/e2e-cleanup-submit")).status, "handled");
    const deadline = Date.now() + 15_000;
    while (fixture.assertions().inferenceRequests < 10 || ((await submitted.request("get_state")).data as { isStreaming: boolean }).isStreaming) {
      assert.ok(Date.now() < deadline, "Extension-submitted cleanup did not settle");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fixture.assertions().inferenceRequests, 10);
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { calls: unknown[] }).calls.length, calls.length + 6);
    assert.equal(await git("rev-parse", "changed-later"), changed);
    const requests = fixture.assertions().inferenceRequests;
    await unlink(join(platform, "hooks", "cleanup_git_pi.py"));
    assert.equal((await fixture.rpc().prompt(`/skill:cleanup-git ${MARKER}`)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, requests);
    await unlink(skill);
    assert.equal((await fixture.rpc().prompt(`/cleanup-git ${MARKER}`)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, requests);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["cleanup-git"], { scope });
    await assert.rejects(access(join(platform, "extensions", "harness-cleanup-git", "index.ts")));
    await assert.rejects(access(join(platform, "hooks", "pi-support", "bridge.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { scope, mode, version: fixture.version, inferenceRequests: requests, readOnlyAudit: true, changedBranchPreserved: true, removed: true };
  } finally { await fixture.close(); }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(text).join("\n");
  return "";
}
