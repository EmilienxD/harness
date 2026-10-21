import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

const exec = promisify(execFile);
const shell = process.platform === "win32" ? "powershell" : "bash";
const writeCommand = shell === "powershell" ? "Set-Content -Path shell.txt -Value shell -NoNewline" : "printf shell > shell.txt";
const deleteCommand = shell === "powershell" ? "Remove-Item -LiteralPath deleted.txt" : "rm deleted.txt";
const scenarios = {
  basic: [{ checkpoint: "native-write", tool: "write", input: { path: "@owned.txt", content: "owned\n" } },
    { checkpoint: "native-edit", tool: "edit", input: { path: "edited.txt", edits: [{ oldText: "before", newText: "after" }] } },
    { checkpoint: "literal-shell-write", tool: shell, input: { command: writeCommand } },
    { checkpoint: "literal-pathspec", tool: "write", input: { path: "space [literal].txt", content: "literal\n" } }],
  nested: [{ checkpoint: "nested-writes", tool: "commit_probe", input: { mode: "nested" } }],
  overlap: [{ checkpoint: "overlapping-writes", tool: "commit_probe", input: { mode: "overlap" } }],
  owned: [{ checkpoint: "owned-write", tool: "write", input: { path: "owned.txt", content: "changed\n" } }],
  race: [{ checkpoint: "race-owned-write", tool: "write", input: { path: "owned.txt", content: "race\n" } }],
  delete: [{ checkpoint: "literal-shell-deletion", tool: shell, input: { command: deleteCommand } }],
  unknown: [{ checkpoint: "unrecognizable-shell-write", tool: shell, input: { command: "node -e \"require('fs').writeFileSync(process.argv[1], 'unknown')\" unknown.txt" } }],
  failed: [{ checkpoint: "failed-shell-write", tool: shell, input: { command: `${writeCommand}${shell === "powershell" ? "; exit 1" : "; exit 1"}` } }],
  baseline: [{ checkpoint: "observed-head-change", tool: shell, input: { command: "git commit --allow-empty -m observed-baseline" } },
    { checkpoint: "after-baseline-write", tool: "write", input: { path: "edited.txt", content: "new baseline\n" } }],
} as const;

async function fixtureFor() {
  const routes = Object.entries(scenarios).map(([name, steps]) => ({ name, scenario: createPiToolScenario({ name: `pi-commit-${name}`, marker: `[E2E:pi-commit-${name}]`, steps }) }));
  return createPiFixture({ scenarioCatalogHash: routes.map((route) => route.scenario.scenarioCatalogHash).join(":"), transition: (request) => {
    const users = request.input.filter((entry) => entry.role === "user");
    const latest = users.at(-1);
    const route = routes.find(({ name }) => text(latest?.content).includes(`[E2E:pi-commit-${name}]`));
    if (!latest || !route) throw new Error("Pi commit unknown scenario history");
    // Each scripted turn is independently closed over its native tool history.
    return route.scenario.transition({ ...request, input: request.input.slice(request.input.indexOf(latest)) });
  } });
}

async function setup(fixture: Awaited<ReturnType<typeof fixtureFor>>, scope: "project" | "user", composition = false) {
  const project = fixture.workspace.projectRoot;
  const git = async (...args: string[]) => (await exec("git", args, { cwd: project, env: fixture.workspace.env, windowsHide: true })).stdout.trim();
  await writeFile(join(project, ".gitignore"), ".pi/\n.harness/\n");
  for (const name of ["owned.txt", "edited.txt", "foreign.txt", "staged.txt", "deleted.txt"]) await writeFile(join(project, name), "before\n");
  await git("init", "-b", "main"); await git("config", "user.email", "e2e@example.invalid"); await git("config", "user.name", "Harness E2E");
  await git("config", "core.autocrlf", "false"); await git("add", "."); await git("commit", "-m", "seed");
  await runFixtureInstaller(fixture.workspace, "install", composition ? ["commit", "prefer-fewer-comments"] : ["commit"], { scope });
  const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
  const settingsPath = join(project, ".pi", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.defaultTools = ["read", "write", "edit", shell, "commit_probe"];
  await writeFile(settingsPath, JSON.stringify(settings));
  await mkdir(join(project, ".harness"), { recursive: true });
  await mkdir(join(platform, "extensions"), { recursive: true });
  await copyFile(join(await findHarnessRoot(), "tests", "e2e", "tools", "pi-commit", "probe.ts.txt"), join(platform, "extensions", "z-commit-probe.ts"));
  return { project, platform, git };
}

export async function runPiCommit(scope: "project" | "user", mode: "json" | "rpc") {
  const fixture = await fixtureFor();
  try {
    const { project, platform, git } = await setup(fixture, scope, true);
    await writeFile(join(project, "foreign.txt"), "foreign\n");
    await writeFile(join(project, "staged.txt"), "staged\n"); await git("add", "staged.txt");
    const indexBefore = await git("show", ":staged.txt");
    const seed = await git("rev-parse", "HEAD");
    const rpc = fixture.rpc({ timeoutMs: 120_000 });
    const commands = (await rpc.request("get_commands")).data as { commands: { name: string; source: string }[] };
    assert.ok(commands.commands.some((e) => e.name === "commit" && e.source === "extension"));
    assert.equal((await rpc.prompt("/commit --dry")).status, "handled");
    assert.equal((await rpc.prompt("/commit")).status, "handled");
    assert.equal(await git("rev-parse", "HEAD"), seed);
    assert.equal(fixture.assertions().inferenceRequests, 0);
    let sessionFile: string | undefined;
    if (mode === "json") {
      assert.equal((await fixture.runJson({ prompt: "[E2E:pi-commit-basic]", sessionId: "commit-basic" })).status, "success");
      const { readdir } = await import("node:fs/promises");
      sessionFile = join(fixture.workspace.sessionsDir, (await readdir(fixture.workspace.sessionsDir)).find((e) => e.includes("commit-basic"))!);
      assert.ok(sessionFile);
      const beforeDry = await readFile(join(project, ".git", "index"));
      const dry = await fixture.runJson({ prompt: "/skill:commit --dry preview", sessionFile });
      assert.equal(dry.toolExecutions.length, 0);
      assert.deepEqual(await readFile(join(project, ".git", "index")), beforeDry);
      assert.equal(await git("rev-parse", "HEAD"), seed);
      assert.equal((await fixture.runJson({ prompt: "/commit verified fixture", sessionFile })).toolExecutions.length, 0);
    } else {
      assert.equal((await rpc.prompt("[E2E:pi-commit-basic]")).status, "success");
      assert.equal((await rpc.prompt("/commit-reload")).status, "handled");
      const beforeDry = await readFile(join(project, ".git", "index"));
      assert.equal((await rpc.prompt("/skill:commit --dry preview")).status, "handled");
      assert.deepEqual(await readFile(join(project, ".git", "index")), beforeDry);
      assert.equal(await git("rev-parse", "HEAD"), seed);
      assert.equal((await rpc.prompt("/commit verified fixture")).status, "handled");
    }
    assert.equal(await git("log", "-1", "--format=%s"), "verified fixture");
    assert.deepEqual((await git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split(/\r?\n/).sort(), ["edited.txt", "owned.txt", "shell.txt", "space [literal].txt"]);
    assert.equal(await git("show", ":staged.txt"), indexBefore);
    assert.equal(await git("diff", "--cached", "--name-only"), "staged.txt");
    assert.equal(await readFile(join(project, "foreign.txt"), "utf8"), "foreign\n");
    assert.match(await git("log", "-1", "--format=%B"), /Pi-session: /);
    assert.equal(fixture.assertions().inferenceRequests, 5);
    const committed = await git("rev-parse", "HEAD");
    if (sessionFile) await fixture.runJson({ prompt: "/commit repeat", sessionFile });
    else await rpc.prompt("/commit repeat");
    assert.equal(await git("rev-parse", "HEAD"), committed);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["commit"], { scope });
    await assert.rejects(readFile(join(platform, "npm/node_modules/harness-pi-commit", "extensions", ".harness-commit", "index.ts")));
    await readFile(join(platform, "npm/node_modules/harness-pi-pi-transport", "harness", "pi-transport", "transport.ts"));
    await runFixtureInstaller(fixture.workspace, "uninstall", ["prefer-fewer-comments"], { scope });
    await assert.rejects(readFile(join(platform, "npm/node_modules/harness-pi-pi-transport", "harness", "pi-transport", "transport.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { scope, mode, version: fixture.version, inferenceRequests: 5, isolatedIndex: true, removed: true };
  } finally { await fixture.close(); }
}

export async function runPiCommitLifecycle() {
  const fixture = await fixtureFor();
  try {
    const { project, platform, git } = await setup(fixture, "project");
    const rpc = fixture.rpc({ timeoutMs: 180_000 });
    const seed = await git("rev-parse", "HEAD");
    const prompt = async (name: keyof typeof scenarios) => assert.equal((await rpc.prompt(`[E2E:pi-commit-${name}]`)).status, "success");
    const command = async (value: string) => assert.equal((await rpc.prompt(value)).status, "handled");
    await command("/commit-anchor"); await prompt("nested"); await command("/commit-inspect");
    const inspected = JSON.parse(await readFile(join(project, ".harness", "inspect.json"), "utf8"));
    assert.equal(inspected.nested, true); assert.equal(inspected.writes, 1);
    await assert.rejects(readFile(join(project, "denied.txt"))); await assert.rejects(readFile(join(project, "absent.txt")));
    await command("/commit-reload"); await command("/commit-back"); await command("/commit abandoned");
    assert.equal(await git("rev-parse", "HEAD"), seed);
    // The selected ancestry is durably recoverable even without another model turn.
    const resumed = await fixture.runJson({ prompt: "/commit resumed-abandoned", sessionFile: inspected.sessionFile });
    assert.equal(resumed.toolExecutions.length, 0); assert.equal(await git("rev-parse", "HEAD"), seed);
    await command("/commit-new"); await prompt("nested"); await command("/commit contaminated");
    // This session overwrote a dirty file left by the abandoned branch.
    assert.equal(await git("rev-parse", "HEAD"), seed);
    await unlink(join(project, "nested.txt")); await command("/commit-new"); await prompt("nested"); await command("/commit nested verified");
    assert.equal(await git("log", "-1", "--format=%s"), "nested verified");
    const baseline = await git("rev-parse", "HEAD");
    await command("/commit-new"); await prompt("overlap"); await command("/commit overlap");
    assert.equal(await git("rev-parse", "HEAD"), baseline); assert.equal(await git("diff", "--cached", "--name-only"), "");
    await git("checkout", "--", "owned.txt");
    await command("/commit-new"); await writeFile(join(project, "owned.txt"), "user work\n"); await prompt("owned"); await command("/commit mixed");
    assert.equal(await git("rev-parse", "HEAD"), baseline); assert.equal(await git("diff", "--cached", "--name-only"), "");
    await git("checkout", "--", "owned.txt");
    await command("/commit-new"); await prompt("owned");
    await writeFile(join(project, ".harness", "partial-index.txt"), "partial foreign\n");
    const partialObject = await git("hash-object", "-w", ".harness/partial-index.txt");
    await git("update-index", "--cacheinfo", "100644", partialObject, "owned.txt");
    const staged = await git("show", ":owned.txt"); const indexBytes = await readFile(join(project, ".git", "index"));
    assert.notEqual(staged, (await readFile(join(project, "owned.txt"), "utf8")).trim());
    await command("/commit partial-index");
    assert.equal(await git("rev-parse", "HEAD"), baseline); assert.equal(await git("show", ":owned.txt"), staged);
    assert.deepEqual(await readFile(join(project, ".git", "index")), indexBytes);
    await git("reset", "HEAD", "owned.txt"); await command("/commit staged-released");
    assert.equal(await git("log", "-1", "--format=%s"), "staged-released");
    const next = await git("rev-parse", "HEAD");
    await command("/commit-new"); await prompt("race"); await writeFile(join(project, "owned.txt"), "later external work\n"); await command("/commit stale");
    assert.equal(await git("rev-parse", "HEAD"), next); await git("checkout", "--", "owned.txt");
    await command("/commit-new"); await prompt("delete"); await command("/commit literal deletion");
    assert.equal(await git("log", "-1", "--format=%s"), "literal deletion"); await assert.rejects(git("show", "HEAD:deleted.txt"));
    const deleted = await git("rev-parse", "HEAD");
    await command("/commit-new"); await prompt("unknown"); await command("/commit unknown");
    assert.equal(await git("rev-parse", "HEAD"), deleted); assert.equal(await git("diff", "--cached", "--name-only"), "");
    await command("/commit-new"); await prompt("failed"); await command("/commit failed-shell");
    assert.equal(await git("rev-parse", "HEAD"), deleted); assert.equal(await git("diff", "--cached", "--name-only"), "");
    await unlink(join(project, "shell.txt"));
    await command("/commit-new"); await prompt("race"); await command("/commit-inspect");
    assert.ok(JSON.parse(await readFile(join(project, ".harness", "inspect.json"), "utf8")).writes > 0);
    await command("/commit-fork"); await command("/commit fork-owned");
    assert.equal(await git("rev-parse", "HEAD"), deleted); await git("checkout", "--", "owned.txt");
    await git("checkout", "-b", "merge-fixture"); await writeFile(join(project, "merge-side.txt"), "side\n");
    await git("add", "merge-side.txt"); await git("commit", "-m", "merge-side"); await git("checkout", "main");
    await git("merge", "--no-commit", "--no-ff", "merge-fixture");
    await command("/commit-new"); await prompt("race");
    const mergeIndex = await readFile(join(project, ".git", "index")); await command("/commit merge-isolation");
    assert.equal(await git("rev-parse", "HEAD"), deleted); assert.deepEqual(await readFile(join(project, ".git", "index")), mergeIndex);
    await git("merge", "--abort"); await git("checkout", "--", "owned.txt");
    await command("/commit-new"); await prompt("baseline"); await command("/commit baseline-owned");
    assert.equal(await git("log", "-1", "--format=%s"), "baseline-owned");
    const observed = await git("rev-parse", "HEAD");
    await command("/commit-new"); await unlink(join(platform, "npm/node_modules/harness-pi-commit", "harness", "commit_pi.py")); await prompt("owned"); await command("/commit outage");
    assert.equal(await git("rev-parse", "HEAD"), observed);
    assert.equal(fixture.assertions().inferenceRequests, 29);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, inferenceRequests: 29, branchIsolation: true, overlapRefused: true, dirtyOwnedRefused: true, mergeIsolation: true };
  } finally { await fixture.close(); }
}

export async function runPiCommitAi() {
  const fixture = await fixtureFor();
  let calls = 0;
  let fail = false;
  let racePath: string | undefined;
  let indexMutation: (() => Promise<void>) | undefined;
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers["x-goog-api-key"] !== token || request.method !== "POST" || request.url !== "/v1beta/models/gemini-3.1-flash-lite:generateContent") {
      response.writeHead(400); response.end("{}"); return;
    }
    let bytes = ""; request.setEncoding("utf8"); request.on("data", (value: string) => {
      bytes += value;
      if (Buffer.byteLength(bytes) > 512 * 1024) request.destroy();
    });
    request.on("end", async () => {
      calls += 1;
      let payload: any;
      try { payload = JSON.parse(bytes); } catch { response.writeHead(400); response.end("{}"); return; }
      if (payload?.generationConfig?.responseMimeType !== "application/json" || typeof payload?.contents?.[0]?.parts?.[0]?.text !== "string") {
        response.writeHead(400); response.end("{}"); return;
      }
      if (fail) { response.writeHead(503); response.end("{}"); return; }
      if (racePath) await writeFile(racePath, "arrived while generating\n");
      if (indexMutation) await indexMutation();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ subject: "Generated fixture message", body: "Verified native session write.", reasoning: "Fixture" }) }] } }] }));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    Object.assign(fixture.workspace.env, { GEMINI_API_KEY: token, COMMIT_AI_BASE_URL: `http://127.0.0.1:${address.port}`, COMMIT_AI_MODEL: "gemini-3.1-flash-lite" });
    const { project, git } = await setup(fixture, "project");
    const rpc = fixture.rpc({ timeoutMs: 120_000 });
    assert.equal((await rpc.prompt("[E2E:pi-commit-owned]")).status, "success");
    assert.equal((await rpc.prompt("/commit --ai")).status, "handled");
    assert.equal(calls, 1); assert.equal(await git("log", "-1", "--format=%s"), "Generated fixture message");
    const baseline = await git("rev-parse", "HEAD");
    await rpc.prompt("/commit-new");
    await rpc.prompt("[E2E:pi-commit-basic]"); fail = true;
    assert.equal((await rpc.prompt("/commit --ai")).status, "handled");
    assert.equal(calls, 2); assert.equal(await git("rev-parse", "HEAD"), baseline);
    assert.deepEqual((await git("diff", "--cached", "--name-only")).split(/\r?\n/).sort(), ["edited.txt", "owned.txt", "shell.txt", "space [literal].txt"]);
    assert.equal((await rpc.prompt("/commit explicit recovery")).status, "handled"); assert.equal(await git("log", "-1", "--format=%s"), "explicit recovery");
    await git("reset", "HEAD"); await git("checkout", "--", "owned.txt", "edited.txt"); await unlink(join(project, "shell.txt"));
    await unlink(join(project, "space [literal].txt"));
    // The tracked new files must be restored before replaying the native writes.
    await git("checkout", "--", "shell.txt", "space [literal].txt");
    const recovery = await git("rev-parse", "HEAD");
    await rpc.prompt("/commit-new"); await rpc.prompt("[E2E:pi-commit-race]");
    fail = false; racePath = join(project, "owned.txt");
    assert.equal((await rpc.prompt("/commit --ai")).status, "handled");
    assert.equal(calls, 3); assert.equal(await git("rev-parse", "HEAD"), recovery);
    assert.equal(await git("show", ":owned.txt"), "race");
    assert.equal(await readFile(racePath, "utf8"), "arrived while generating\n");
    await git("reset", "HEAD"); await git("checkout", "--", "owned.txt");
    await rpc.prompt("/commit-new"); await rpc.prompt("[E2E:pi-commit-race]"); racePath = undefined;
    indexMutation = async () => { await git("reset", "HEAD", "owned.txt"); };
    assert.equal((await rpc.prompt("/commit --ai")).status, "handled");
    assert.equal(calls, 4); assert.equal(await git("rev-parse", "HEAD"), recovery);
    assert.equal(await git("diff", "--cached", "--name-only"), "");
    assert.equal(fixture.assertions().inferenceRequests, 11); assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, inferenceRequests: 11, aiCalls: 4, aiFailureIndexPreserved: true, generationRaceRefused: true, foreignIndexRefused: true };
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fixture.close(); }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object" && "text" in value) return text(value.text);
  return "";
}
