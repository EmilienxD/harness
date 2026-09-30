import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { isolatedClaudeEnvironment, validateClaudeCli } from "../../core/claude.js";
import { prepareCodexHome, validateCodexCli } from "../../core/codex.js";
import { startFakeOpenAiServer } from "../../core/openai-server.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { spawnableCommand } from "../../core/path.js";
import { findHarnessRoot } from "../issues/support.js";
import { claudeTransition, codexTransition, COMPLETE, LEAD, plan, PR_LEAD, REPORT, scenarioCatalogHash, stub, testName, unit, workflow, type ShipScenario } from "./scenario.js";

const exec = promisify(execFile);
const repository = "EmilienxD/harness-e2e";
export type ShipPlatform = "claude" | "chatgpt";
type Json = Record<string, any>;

const gh = async (...args: string[]) => (await exec("gh", args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const graphql = (query: string, variables: Record<string, string>) =>
  gh("api", "graphql", "-f", `query=${query}`, ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]));

export async function runShipJourney(platform: ShipPlatform, scenario: ShipScenario): Promise<Json> {
  if (platform === "claude") await validateClaudeCli(); else await validateCodexCli();
  const identity = JSON.parse(await gh("repo", "view", repository, "--json", "nameWithOwner,isPrivate")) as Json;
  assert.deepEqual(identity, { nameWithOwner: repository, isPrivate: true });
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-ship-e2e-"));
  const project = join(root, "repository");
  const prefix = `ship-e2e-${root.split(/[/\\]/u).at(-1)!.replace(/^harness-ship-e2e-/u, "").toLowerCase()}`;
  const target = `${prefix}-base`;
  const state = join(root, "state");
  const bin = join(root, "bin");
  const status = join(root, "cli-status");
  const issues: Record<string, number> = {};
  let server: { close(): Promise<void>; assertions(): { readonly checkpoints: readonly string[]; readonly unexpectedRequests: number; readonly observations: readonly Json[] } } | undefined;
  let env: NodeJS.ProcessEnv = { ...process.env };
  let python = "";
  let runtimeSource = "";
  let success = false;
  let labels: string[] = [];
  try {
    const harness = await findHarnessRoot(process.cwd());
    runtimeSource = join(harness, "harness", "productivity", "subagents", "runtime", "src");
    python = join(harness, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    // Scripted shell commands pass these paths unquoted to both Bash and PowerShell.
    assert.doesNotMatch(`${root}${python}`, /\s/u, "ship E2E paths must not contain whitespace");
    await exec(python, ["-c", "import pytest; import harness_cli"], { windowsHide: true });
    await exec("git", ["clone", "--quiet", `https://github.com/${repository}.git`, project], { windowsHide: true, timeout: 60000 });
    for (const [key, value] of [["user.name", "Harness Ship E2E"], ["user.email", "ship-e2e@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
      await exec("git", ["config", key!, value!], { cwd: project, windowsHide: true });
    }
    // Every merge lands on this run's own target branch, never on the fixture's main.
    await exec("git", ["switch", "--quiet", "-c", target], { cwd: project, windowsHide: true });
    await exec("git", ["push", "--quiet", "-u", "origin", target], { cwd: project, windowsHide: true, timeout: 60000 });
    labels = (JSON.parse(await gh("label", "list", "--repo", repository, "--limit", "200", "--json", "name")) as { name: string }[]).map((item) => item.name);
    const eligible = JSON.parse(await gh("issue", "list", "--repo", repository, "--state", "open", "--label", "[AI]-triaged", "--json", "number")) as unknown[];
    assert.equal(eligible.length, 0, "ship fixture requires no existing triaged issue; leave other runs untouched");
    const auto = scenario === "leaves" || scenario === "blocker-auto-merge";
    for (const label of ["[AI]-triaged", ...(auto ? ["[AI]-auto-merge"] : [])]) {
      if (!labels.includes(label)) await gh("label", "create", label, "--repo", repository);
    }
    await writeFile(join(root, "issue-body.md"), "Add a CLI that prints Hello staging. Preserve the issue for staging verification.\n");
    const create = async (key: string, extra: string[]) => {
      const url = await gh("issue", "create", "--repo", repository, "--title", `E2E ship ${key} ${prefix}`, "--body-file", join(root, "issue-body.md"), ...extra);
      issues[key] = Number(url.split("/").at(-1));
      assert.ok(Number.isSafeInteger(issues[key]) && issues[key]! > 0);
    };
    const nodeId = async (key: string) => gh("issue", "view", String(issues[key]), "--repo", repository, "--json", "id", "--jq", ".id");
    if (scenario === "leaves") {
      // Created in reverse so that number order disagrees with dependency order.
      for (const key of ["b", "a"]) await create(key, ["--label", "[AI]-auto-merge"]);
      await create("parent", []);
      for (const key of ["b", "a"]) await graphql("mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}", { p: await nodeId("parent"), c: await nodeId(key) });
      await graphql("mutation($i:ID!,$b:ID!){addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){issue{number}}}", { i: await nodeId("b"), b: await nodeId("a") });
    } else {
      await create("main", ["--label", "[AI]-triaged", ...(scenario === "blocker-auto-merge" ? ["--label", "[AI]-auto-merge"] : [])]);
    }
    await mkdir(state, { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(status, { recursive: true });
    for (const key of Object.keys(env)) if (key.startsWith("HARNESS_") || key.startsWith("ABOARD_")) delete env[key];
    env = { ...env, UV_TOOL_DIR: join(root, "uv-tools"), UV_TOOL_BIN_DIR: bin,
      HARNESS_STATE_DIR: state, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PYTHONIOENCODING: "utf-8" };
    // This is the real installer, real uv host-tool builds and both provider payloads.
    // --local is the product's supported development install path, not a mock.
    await exec(python, ["-m", "harness_cli", "--local", harness, "install", "ship", "cleanup-git", "--root", project, "--json"], { cwd: harness, env, windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    for (const name of ["ship", "test-workflows", "cleanup-git"]) {
      await readFile(join(project, ".claude", "skills", name, "SKILL.md"));
      await readFile(join(project, ".agents", "skills", name, "SKILL.md"));
    }
    const bridge = join(harness, "tests", "e2e", "dist", "tools", "subagents", "cli-bridge.js");
    const provider = spawnableCommand(platform === "claude" ? "claude" : "codex", []);
    await writeFile(join(state, "config.json"), JSON.stringify({ terminalCommand: [process.execPath, bridge, "--spawn"] }));
    await writeFile(join(project, ".harness", "config.json"), JSON.stringify({ version: 1,
      providers: { [platform]: { command: [process.execPath, bridge, "--provider", platform, provider.file, ...provider.args] } },
      session: { stopWaitHours: 0.05 }, ...(scenario === "fresh-cap" ? { loop: { maxFeedback: 1, maxImplementers: 2 } } : {}) }));
    const excluded = [".claude/", ".codex/", ".agents/", ".harness/", "AGENTS.md", "CLAUDE.md"];
    await writeFile(join(project, ".git", "info", "exclude"), `${excluded.join("\n")}\n`);
    await writeFile(join(project, "AGENTS.md"), `Target branch: ${target}. Merge method: squash. Unit tests: tests/unit/. Workflows: tests/workflow/. Create worktrees only with the make_worktree.py command referenced by the ship fixture instructions.\n`);
    await writeFile(join(root, "make_worktree.py"), [
      "import pathlib, shutil, subprocess, sys",
      "source = pathlib.Path.cwd(); destination = pathlib.Path(sys.argv[1])",
      "subprocess.run(['git','worktree','add','-b',sys.argv[2],str(destination),sys.argv[3] if len(sys.argv) > 3 else 'HEAD'],check=True)",
      "for name in ['.claude','.codex','.agents','.harness']:",
      " if (source/name).exists(): shutil.copytree(source/name,destination/name,dirs_exist_ok=True)",
      "shutil.copy2(source/'AGENTS.md',destination/'AGENTS.md')",
      "(destination/'.harness'/'initialized').write_text('configured worktree')",
    ].join("\n"));
    const units = Object.fromEntries(["main", "a", "b", "blk"].map((key) => {
      const item = unit(key);
      return [key, { ...item, criteria: { [item.test]: stub(testName(item)), [item.workflow]: workflow(item.module) } }];
    }));
    await writeFile(join(root, "fixture.json"), JSON.stringify({ repository, target, branch_prefix: prefix, issues, units }));
    const e2e = join(harness, "tests", "e2e", "tools", "ship");
    for (const name of ["driver.py", "implementer.py"]) await cp(join(e2e, name), join(root, name));
    const r = root.replaceAll("\\", "/");
    for (const child of Object.keys(plan(scenario, root, python).children)) {
      const key = child === "impl1" || child === "impl2" ? "main" : child.replace(/^impl/u, "");
      const item = unit(key);
      const inputs = child === "impl2"
        ? `\nYou replace an earlier implementer. Review ${r}/inputs-impl2/original-prompt.md, ${r}/inputs-impl2/branch.diff, ${r}/inputs-impl2/last-report.json and ${r}/inputs-impl2/problems.md, then fix the work.\n` : "";
      await writeFile(join(root, `implementer-${child}.md`), `Fill the stubbed test in ${item.test} and implement ${item.module} without adding tests. Run the tests and the workflows under tests/workflow/.${inputs}\nList every stub test and every required test workflow in your report, each with its result and evidence paths stored outside the repository.\n`);
    }
    const slash = platform === "claude" ? "/" : "$";
    if (platform === "claude") {
      const anthropic = await startFakeAnthropicServer({ repoRoot: root, diagnosticsPath: join(root, "structural-diagnostics.json"), scenarioCatalogHash,
        parseRequest: parseAnthropicMessagesRequest, transition: (request) => claudeTransition(request, root, scenario, python) });
      server = anthropic;
      const config = join(root, "claude-config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "settings.json"), "{}\n");
      env = isolatedClaudeEnvironment(env, { ANTHROPIC_BASE_URL: anthropic.baseUrl, ANTHROPIC_AUTH_TOKEN: anthropic.authToken,
        CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost" });
    } else {
      const openai = await startFakeOpenAiServer({ diagnosticsPath: join(root, "structural-diagnostics.json"), scenarioCatalogHash,
        transition: (request) => codexTransition(request, root, scenario, python) });
      server = openai;
      // Fallback metadata for an unknown model offers no apply_patch tool; declare
      // the native freeform tool real GPT models use so edits take Codex's edit path.
      const catalog = join(root, "codex-models.json");
      await writeFile(catalog, JSON.stringify({ models: [{ slug: "codex-e2e", display_name: "codex-e2e", description: null, supported_reasoning_levels: [],
        shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 1, availability_nux: null, upgrade: null, support_verbosity: false,
        default_verbosity: null, apply_patch_tool_type: "freeform", truncation_policy: { mode: "bytes", limit: 10000 }, context_window: 272000,
        experimental_supported_tools: [], base_instructions: "You are a deterministic Harness E2E model." }] }));
      const home = await prepareCodexHome({ root, baseUrl: openai.baseUrl, trustedProjects: [project], modelCatalog: catalog, extraConfig: ["[features]", "hooks = true"] });
      env = { ...env, CODEX_HOME: home, HARNESS_E2E_OPENAI_KEY: openai.authToken, NO_PROXY: "127.0.0.1,localhost" };
      for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) delete env[key];
    }
    env = { ...env, HARNESS_E2E_CLI_DIR: status, HARNESS_E2E_PARENT_COMPLETE: COMPLETE, HARNESS_E2E_CHILD_COMPLETE: REPORT, HARNESS_E2E_CLI_TIMEOUT_MS: "900000" };
    const runtime = join(bin, process.platform === "win32" ? "harness.exe" : "harness");
    const lead = async (prompt: string) => {
      await rm(join(status, "parent.json"), { force: true });
      await exec(runtime, ["run", "--provider", platform, prompt], { cwd: project, env, windowsHide: true, timeout: 30000 });
      await waitForProcesses(status, Date.now() + 900000);
    };
    await lead(`${slash}ship ${scenario === "leaves" ? `#${issues.parent}` : ""} ${LEAD}`.replace("  ", " "));
    let record = JSON.parse(await readFile(join(root, "run.json"), "utf8")) as Json;
    const facts: Json = {};
    if (scenario === "decision-resume") {
      facts.firstDraft = (JSON.parse(await gh("pr", "view", record.prs.main, "--json", "isDraft")) as Json).isDraft;
      // The user answers the Lead's question on the PR, then resumes delivery with /ship <PR>.
      await gh("pr", "review", record.prs.main, "--comment", "--body", "Decision: implement it without the external service.");
      await lead(`${slash}ship ${record.prs.main} ${PR_LEAD}`);
      record = JSON.parse(await readFile(join(root, "run.json"), "utf8")) as Json;
    }
    const assertions = server!.assertions();
    assert.equal(assertions.unexpectedRequests, 0);
    assert.ok(assertions.checkpoints.includes("lead-complete"));
    const view = async (key: string) => JSON.parse(await gh("issue", "view", String(record.issues[key]), "--repo", repository, "--json", "state,labels,comments")) as Json;
    const labelsOf = (item: Json) => (item.labels as { name: string }[]).map((label) => label.name);
    const pr = async (key: string) => JSON.parse(await gh("pr", "view", record.prs[key], "--json", "state,body,isDraft,mergedAt,mergeCommit,title")) as Json;
    const blockedBy = async (key: string) => (JSON.parse((await exec("issue-context", [String(record.issues[key])], { cwd: project, env, windowsHide: true })).stdout) as Json).blocked_by.map((item: Json) => item.number);
    const delivered = async (key: string, merged: boolean) => {
      const issue = await view(key);
      assert.equal(issue.state, "OPEN", `${key} issue must stay open`);
      assert.ok(labelsOf(issue).includes("[AI]-in-progress"), `${key} keeps its claim`);
      const pull = await pr(key);
      assert.equal(pull.state, merged ? "MERGED" : "OPEN");
      assert.equal(pull.isDraft, false);
      assert.match(pull.body, new RegExp(`Refs #${record.issues[key]}\\b`, "u"));
      assert.doesNotMatch(`${pull.title}\n${pull.body}`, /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#/iu);
      assert.ok((issue.comments as Json[]).some((item) => item.body.includes(record.prs[key])), `${key} comment links its PR`);
      assert.equal(record.contracts[key].state, "pass");
      if (merged) {
        const parents = (await exec("git", ["rev-list", "--parents", "-n", "1", pull.mergeCommit.oid], { cwd: project, windowsHide: true }).catch(async () => {
          await exec("git", ["fetch", "--quiet", "origin", target], { cwd: project, windowsHide: true });
          return exec("git", ["rev-list", "--parents", "-n", "1", pull.mergeCommit.oid], { cwd: project, windowsHide: true });
        })).stdout.trim().split(" ");
        assert.equal(parents.length, 2, `${key} must be squash merged`);
      }
      return pull;
    };
    const decided = async (key: string) => {
      const issue = await view(key);
      assert.equal(issue.state, "OPEN");
      assert.ok(["[AI]-in-progress", "[AI]-needs-decision"].every((label) => labelsOf(issue).includes(label)));
      assert.ok((issue.comments as Json[]).some((item) => item.body.includes(record.prs[key]) && item.body.includes("?")), "decision comment names the draft and question");
    };
    if (scenario === "feedback") {
      await delivered("main", false);
      assert.equal(record.feedback.impl1, 1);
      assert.ok(assertions.checkpoints.includes("impl1-r2-test-after-notice"), "test-workflows edit notice must reach the implementer");
      const anchorFiles = (await exec("git", ["diff", "--name-only", record.base.main, record.anchor.main], { cwd: join(root, "wt-main"), windowsHide: true })).stdout.trim().split(/\r?\n/u).sort();
      assert.deepEqual(anchorFiles, [unit("main").test, unit("main").workflow].sort());
      assert.match(await readFile(join(root, "evidence", "anchor-main-red.txt"), "utf8"), /1 failed/u);
      assert.match(await readFile(join(root, "evidence", "impl1-green.txt"), "utf8"), /1 passed/u);
      assert.equal((await readFile(join(root, "evidence", "impl1-workflow.txt"), "utf8")).trim(), "Hello staging");
      assert.equal(await readFile(join(root, "wt-main", ".harness", "initialized"), "utf8"), "configured worktree");
      assert.ok(record.reports.impl1.every((item: Json) => "context_usage" in item));
    } else if (scenario === "leaves") {
      assert.deepEqual(record.leaf_order, [issues.a, issues.b]);
      const a = await delivered("a", true);
      const b = await delivered("b", true);
      assert.ok(Date.parse(a.mergedAt) < Date.parse(b.mergedAt), "the blocking leaf merges first");
      assert.equal(Object.keys(record.prs).length, 2, "one PR per leaf");
    } else if (scenario === "decision-resume") {
      assert.equal(facts.firstDraft, true);
      const blocker = await view("blk");
      assert.ok(labelsOf(blocker).includes("[AI]-help-wanted"));
      assert.deepEqual(await blockedBy("main"), [record.issues.blk]);
      await decided("main");
      await delivered("main", false);
      assert.deepEqual(record.resumed, [record.children.impl1], "the PR Lead resumes the same implementer session");
      assert.ok(assertions.checkpoints.includes("pr-lead-complete"));
    } else if (scenario === "blocker-auto-merge") {
      const blocker = await view("blk");
      assert.ok(["[AI]-help-wanted", "[AI]-auto-merge"].every((label) => labelsOf(blocker).includes(label)));
      assert.deepEqual(await blockedBy("main"), [record.issues.blk]);
      const first = await delivered("blk", true);
      const second = await delivered("main", true);
      assert.ok(Date.parse(first.mergedAt) < Date.parse(second.mergedAt), "the prerequisite is delivered first");
      assert.deepEqual(record.resumed, [record.children.impl1]);
    } else {
      assert.notEqual(record.children.impl1, record.children.impl2);
      assert.equal(record.feedback.impl1, 1);
      assert.equal(record.launch_refusals.length, 1, "a second active implementer is refused");
      assert.deepEqual(record.released, ["impl1", "impl2"]);
      for (const input of ["original", "diff", "report", "problems"]) assert.ok(assertions.checkpoints.includes(`impl2-r1-${input}`), input);
      const pull = await pr("main");
      assert.equal(pull.state, "OPEN");
      assert.equal(pull.isDraft, true);
      await decided("main");
    }
    success = true;
    return { platform, scenario, checkpoints: assertions.checkpoints, unexpectedRequests: 0 };
  } catch (error) {
    const observed = server?.assertions().observations.map((item) => `${item.httpStatus}:${item.checkpoint ?? item.diagnostic ?? "unknown"}`).join(",");
    throw new Error(`${platform}/${scenario}: ${error instanceof Error ? error.message : "ship journey failed"}; structural checkpoints=${observed ?? "not launched"}; fixture=${root}`);
  } finally {
    await server?.close();
    // Only this run's exact issues, PRs, branches and labels are cleaned. Never
    // reset or recreate the shared fixture, and never touch another run's artifacts.
    let record: Json = {};
    try { record = JSON.parse(await readFile(join(root, "run.json"), "utf8")) as Json; } catch { }
    for (const url of Object.values((record.prs ?? {}) as Record<string, string>)) await gh("pr", "close", url).catch(() => undefined);
    for (const number of new Set([...Object.values(issues), ...((record.created_issues ?? []) as number[])])) {
      await gh("issue", "close", String(number), "--repo", repository).catch(() => undefined);
    }
    const refs = await gh("api", `repos/${repository}/git/matching-refs/heads/${prefix}`, "--jq", ".[].ref").catch(() => "");
    for (const ref of refs.split(/\r?\n/u).filter(Boolean)) await gh("api", "-X", "DELETE", `repos/${repository}/git/${ref}`).catch(() => undefined);
    if (labels.length) {
      const now = (JSON.parse(await gh("label", "list", "--repo", repository, "--limit", "200", "--json", "name").catch(() => "[]")) as { name: string }[]).map((item) => item.name);
      for (const label of now.filter((name) => name.startsWith("[AI]-") && !labels.includes(name))) await gh("label", "delete", label, "--repo", repository, "--yes").catch(() => undefined);
    }
    // Stop only processes registered in this run's isolated runtime before
    // removing provider configs/transcripts. Retain only redacted diagnostics.
    if (!success && python) {
      await exec(python, ["-c", [
        "import os, pathlib, signal, sqlite3, subprocess",
        "from subagents_runtime.processes import birth_identity, process_alive",
        "root=pathlib.Path(os.environ['HARNESS_STATE_DIR'])",
        "for path in root.glob('sessions.sqlite3'):",
        " try:",
        "  db=sqlite3.connect(path); rows=db.execute('SELECT supervisor_pid,supervisor_birth,provider_pid,provider_birth FROM executions').fetchall(); db.close()",
        " except sqlite3.Error: continue",
        " for row in rows:",
        "  for pid,birth in [(row[0],row[1]),(row[2],row[3])]:",
        "   if not pid or not birth or not process_alive(pid) or birth_identity(pid)!=birth: continue",
        "   if os.name=='nt': subprocess.run(['taskkill','/PID',str(pid),'/T','/F'],capture_output=True)",
        "   else:",
        "    try: os.kill(pid,signal.SIGTERM)",
        "    except ProcessLookupError: pass",
      ].join("\n")], { env: { ...env, PYTHONPATH: runtimeSource }, windowsHide: true, timeout: 15000 }).catch(() => undefined);
      await cp(join(root, "structural-diagnostics.json"), `${root}.diagnostics.json`).catch(() => undefined);
    }
    // HARNESS_E2E_KEEP=1 retains a failed run's local fixture for manual diagnosis only.
    if (success || process.env.HARNESS_E2E_KEEP !== "1") await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Waits for the Lead process and every implementer process the bridge launched. */
async function waitForProcesses(status: string, deadline: number): Promise<void> {
  while (true) {
    const read = async (name: string) => { try { return JSON.parse(await readFile(join(status, name), "utf8")) as Json; } catch { return undefined; } };
    const parent = await read("parent.json");
    if (parent && parent.status !== "completed") throw new Error(`ship Lead CLI failed: ${JSON.stringify(parent)}`);
    const visible = (await read("visible.json")) ?? { child: 0 };
    const children = await Promise.all((await readdir(status)).filter((name) => /^child-\d+\.json$/u.test(name)).map(read));
    const failed = children.find((item) => item && item.status !== "completed");
    if (failed) throw new Error(`ship implementer CLI failed: ${JSON.stringify(failed)}`);
    if (parent && children.length >= visible.child) return;
    if (Date.now() >= deadline) throw new Error(`ship real CLI timed out: parent=${JSON.stringify(parent)} children=${children.length}/${visible.child}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
