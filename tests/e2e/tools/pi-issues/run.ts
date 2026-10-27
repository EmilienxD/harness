import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createPiFixture } from "../../core/pi-fixture.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { containsPath } from "../../core/path.js";
import { createFakeGh, initializeRepository, pythonCommand, readPublishedIssue } from "../issues/support.js";

function draftSession(id: string): string {
  // UUIDv5, matching the public provider namespace (not the extension implementation).
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(`harness:issues:pi:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function setup(fixture: Awaited<ReturnType<typeof createPiFixture>>, packages: string[], scope: "project" | "user") {
  const gh = await createFakeGh(fixture.root);
  Object.assign(fixture.workspace.env, {
    PATH: `${gh.bin}${delimiter}${fixture.workspace.env.PATH ?? process.env.PATH ?? ""}`,
    PYTHONPATH: gh.bin, HARNESS_E2E_NODE: process.execPath, HARNESS_E2E_FAKE_GH: join(gh.bin, "fake-gh.cjs"),
  });
  await writeFile(join(fixture.workspace.projectRoot, ".gitignore"), ".pi/\n.harness/\n");
  await writeFile(join(fixture.workspace.projectRoot, "target.txt"), "before\n");
  await initializeRepository(fixture.workspace.projectRoot);
  await runFixtureInstaller(fixture.workspace, "install", packages, { scope });
  return gh;
}

export async function runPiIssueReaders(scope: "project" | "user", mode: "json" | "rpc") {
  const marker = "[E2E:pi-issue-readers]";
  const scenario = createPiToolScenario({ name: "pi-issue-readers", marker, steps: [
    { checkpoint: "implement", tool: "write", input: { path: "target.txt", content: "after\n" } },
  ] });
  const fixture = await createPiFixture(scenario);
  try {
    const gh = await setup(fixture, ["issue-readers"], scope);
    const platform = scope === "project" ? join(fixture.workspace.projectRoot, ".pi") : fixture.workspace.agentDir;
    const originalSkills = new Map<string, string>();
    for (const skill of ["address-this", "review-this"]) {
      await assert.rejects(access(join(platform, "skills", skill, "SKILL.md")));
      const path = join(platform, "npm/node_modules/harness-pi-issue-readers", "skills", skill, "SKILL.md");
      const original = await readFile(path, "utf8");
      originalSkills.set(path, original);
      await writeFile(path, original + `\n${marker}\n`);
    }
    const run = mode === "json" ? await fixture.runJson({ prompt: "/skill:address-this 42" }) : await fixture.rpc().prompt("/address-this 42");
    assert.equal(run.status, "success");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, "target.txt"), "utf8"), "after\n");
    assert.equal(fixture.assertions().inferenceRequests, 2);
    const review = await fixture.runJson({ prompt: "/skill:review-this https://github.com/fixture/issues/issues/42" });
    assert.equal(review.status, "success");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    const before = fixture.assertions().inferenceRequests;
    const blocked = await fixture.rpc().prompt("/skill:address-this 42");
    assert.equal(blocked.status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, before);
    const state = JSON.parse(await readFile(gh.statePath, "utf8")) as { calls: string[][] };
    assert.equal(state.calls.filter((call) => call[0] === "api").length, 2);
    await writeFile(join(gh.bin, "fake-gh.cjs"), "process.exitCode = 1;\n");
    assert.equal((await fixture.rpc().prompt("/skill:review-this 42")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, before);
    for (const [path, original] of originalSkills) await writeFile(path, original);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-readers"], { scope });
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-issue-readers")));
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-pi-issue-workflows", "harness", "pi-issue-workflows", "workflows.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, mode, inferenceRequests: before };
  } finally { await fixture.close(); }
}

export async function runPiIssueWriters(scope: "project" | "user") {
  const sessionId = randomUUID();
  const path = `.harness/issue-drafts/${draftSession(sessionId)}.issue-0.md`;
  const content = "# Pi fixture issue\n\n> difficulty:routine, mode:afk\n\nImplement the fixture change.\n";
  const scenarios = ["draft-issue", "draft-issues", "to-spec", "to-spec-draft-issue"].map((name) => ({ name,
    ...createPiToolScenario({ name: `pi-${name}`, marker: `[E2E:pi-${name}]`, steps: name === "draft-issue" ? [
      { checkpoint: "draft", tool: "write", input: { path, content } },
    ] : [] }),
  }));
  const aliasScenario = createPiToolScenario({ name: "removed-writer-alias", marker: "[E2E:removed-writer-alias]", steps: [] });
  const fixture = await createPiFixture({ scenarioCatalogHash: scenarios[0]!.scenarioCatalogHash, transition: (request) => {
    const serialized = JSON.stringify(request.input);
    if (serialized.includes("[E2E:removed-writer-alias]")) return aliasScenario.transition(request);
    const scenario = scenarios.find((entry) => serialized.includes(`[E2E:pi-${entry.name}]`));
    if (!scenario) throw new Error("Unknown Pi issue writer fixture route");
    if (scenario.name === "draft-issue") {
      // Parse supplied workflow data to choose the real tool action; prompt wording is not asserted.
      const text = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(text).join("\n");
        if (value && typeof value === "object" && "text" in value) return text(value.text);
        return "";
      };
      const texts = request.input.map((item) => text(item.content)).join("\n");
      const supplied = /Draft file path: (\S+)/.exec(texts)?.[1];
      if (!supplied || !containsPath(fixture.workspace.projectRoot, join(fixture.workspace.projectRoot, supplied))) throw new Error("Missing or unsafe draft destination");
      return createPiToolScenario({ name: "pi-draft-issue", marker: "[E2E:pi-draft-issue]", steps: [
        { checkpoint: "draft", tool: "write", input: { path: supplied, content } },
      ] }).transition(request);
    }
    return scenario.transition(request);
  } });
  try {
    const gh = await setup(fixture, ["issue-writers", "issue-readers"], scope);
    const platform = scope === "project" ? join(fixture.workspace.projectRoot, ".pi") : fixture.workspace.agentDir;
    const originalSkills = new Map<string, string>();
    for (const scenario of scenarios) {
      const skill = join(platform, "npm/node_modules/harness-pi-issue-writers", "skills", scenario.name, "SKILL.md");
      const original = await readFile(skill, "utf8");
      originalSkills.set(skill, original);
      await writeFile(skill, original + `\n[E2E:pi-${scenario.name}]\n`);
    }
    const probe = join(fixture.workspace.projectRoot, ".pi", "extensions", "issue-test-lifecycle");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), `
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        pi.registerCommand("e2e-issue-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
        pi.on("context_with_system", (event, ctx) => {
          appendFileSync(join(ctx.cwd, "context-counts.jsonl"), JSON.stringify({
            reports: event.messages.filter(m => m.customType === "harness-issue-writers").length,
            notices: event.messages.filter(m => m.customType === "harness-issue-notice").length,
          }) + "\\n");
        });
      }
    `);
    assert.equal((await fixture.runJson({ prompt: "/draft-issue [E2E:removed-writer-alias]" })).status, "success");
    await assert.rejects(access(join(fixture.workspace.projectRoot, ".harness", "issue-drafts")));
    assert.equal((await fixture.runJson({ prompt: "/skill:to-spec fixture" })).status, "success");
    await assert.rejects(access(join(fixture.workspace.projectRoot, ".harness", "issue-drafts")));
    const rpc = fixture.rpc({ sessionId });
    assert.equal((await rpc.prompt("/skill:draft-issue fixture")).status, "success");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, path), "utf8"), content);
    assert.equal((await rpc.prompt("/e2e-issue-reload")).status, "handled");
    const foreign = `.harness/issue-drafts/${draftSession(randomUUID())}.issue-0.md`;
    await writeFile(join(fixture.workspace.projectRoot, foreign), content);
    assert.equal((await fixture.rpc().prompt("/publish-issues")).status, "handled");
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { issues: unknown[] }).issues.length, 0);
    assert.equal((await rpc.prompt("/publish-issues --unknown")).status, "handled");
    const preview = await rpc.prompt("/publish-issues --dry");
    assert.equal(preview.status, "handled");
    assert.ok(preview.events.some(event => event.type === "extension_ui_request" && event.method === "notify"));
    assert.equal(await readFile(join(fixture.workspace.projectRoot, path), "utf8"), content);
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { issues: unknown[] }).issues.length, 0);
    assert.equal((await rpc.prompt("/publish-issues")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    assert.equal((await readPublishedIssue(gh.statePath)).title, "Pi fixture issue");
    await assert.rejects(access(join(fixture.workspace.projectRoot, path)));
    assert.deepEqual(await readdir(join(fixture.workspace.projectRoot, ".harness", "issue-drafts")), [".gitignore", foreign.split("/").at(-1)!].sort());
    const stateDirectory = join(fixture.root, "harness-state", "issues");
    const noticeFiles = (await readdir(stateDirectory)).filter(file => file.endsWith(".notice.json"));
    assert.equal(noticeFiles.length, 1);
    const notice = JSON.parse(await readFile(join(stateDirectory, noticeFiles[0]!), "utf8")) as { created: { draft: string; number: string }[] };
    assert.equal(notice.created[0]!.draft, path);
    assert.equal(notice.created[0]!.number, String((await readPublishedIssue(gh.statePath)).number));
    // Same-session input consumes the notice; the human publication report stays out of context.
    assert.equal((await rpc.prompt("Continue")).status, "success");
    const counts = (await readFile(join(fixture.workspace.projectRoot, "context-counts.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { reports: number; notices: number });
    assert.ok(counts.every(count => count.reports === 0));
    assert.equal(counts.at(-1)!.notices, 1);
    const pending = (await readdir(stateDirectory)).filter(file => file.endsWith(".notice.json"));
    assert.equal(pending.length, 0);
    for (const scenario of scenarios.filter(entry => entry.name === "draft-issues" || entry.name === "to-spec-draft-issue")) {
      assert.equal((await fixture.runJson({ prompt: `/skill:${scenario.name} fixture` })).status, "success");
    }
    assert.equal(fixture.assertions().inferenceRequests, 7);
    await unlink(join(platform, "npm/node_modules/harness-pi-issue-writers", "harness", "issue_writers_pi.py"));
    assert.equal((await rpc.prompt("/skill:draft-issues fixture")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 7);
    for (const [skill, original] of originalSkills) await writeFile(skill, original);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-writers"], { scope });
    await access(join(platform, "npm/node_modules/harness-pi-pi-issue-workflows", "harness", "pi-issue-workflows", "workflows.ts"));
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-readers"], { scope });
    await assert.rejects(access(join(platform, "npm/node_modules/harness-pi-pi-issue-workflows", "harness", "pi-issue-workflows", "workflows.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, inferenceRequests: 7 };
  } finally { await fixture.close(); }
}

export async function runPiAgentIssueWriters(scope: "project" | "user") {
  const sessionId = randomUUID();
  const path = `.harness/issue-drafts/${draftSession(sessionId)}.issue-0.md`;
  const content = "# Pi agent publication\n\n> spec\n\nPublish through the installed script.\n";
  const marker = "[E2E:pi-agent-publication]";
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const python = await pythonCommand();
  let command = "";
  let ghState = "";
  const fixture = await createPiFixture({
    scenarioCatalogHash: createHash("sha256").update("pi-agent-publication:v1").digest("hex"),
    transition: request => createPiToolScenario({ name: "pi-agent-publication", marker, steps: [
      { checkpoint: "draft", tool: "write", input: { path, content } },
      { checkpoint: "preview", tool: shell, input: { command: `${command} --dry` }, verifyResult: output => {
        assert.ok(JSON.stringify(output).includes("1 issue(s) ready to publish"), "Agent did not receive the preview");
        if (request.input.filter(item => item.type === "function_call_output").length === 2) {
          assert.equal((JSON.parse(readFileSync(ghState, "utf8")) as { issues: unknown[] }).issues.length, 0);
          assert.equal(readFileSync(join(fixture.workspace.projectRoot, path), "utf8"), content);
        }
      } },
      { checkpoint: "publish", tool: shell, input: { command }, verifyResult: output => {
        assert.ok(JSON.stringify(output).includes("Published 1 issue(s) successfully."), "Agent did not receive the publication report");
        assert.ok(JSON.stringify(output).includes("https://github.test/fixture/issues/issues/101"), "Agent did not receive the issue URL");
      } },
    ] }).transition(request),
  });
  try {
    const gh = await setup(fixture, ["issue-writers"], scope);
    ghState = gh.statePath;
    const settingsPath = join(fixture.workspace.projectRoot, ".pi/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.defaultTools = ["read", "write", shell];
    await writeFile(settingsPath, JSON.stringify(settings));
    const platform = scope === "project" ? join(fixture.workspace.projectRoot, ".pi") : fixture.workspace.agentDir;
    const script = join(platform, "npm/node_modules/harness-pi-issue-writers/skills/draft-issue/scripts/publish_issues.py").replaceAll("\\", "/");
    command = `${python} "${script}"`;
    const foreign = `.harness/issue-drafts/${draftSession(randomUUID())}.issue-0.md`;
    await mkdir(join(fixture.workspace.projectRoot, ".harness/issue-drafts"), { recursive: true });
    await writeFile(join(fixture.workspace.projectRoot, foreign), content);
    const rpc = fixture.rpc({ sessionId });
    const run = await rpc.prompt(`/skill:draft-issue Publish the draft now ${marker}`);
    if (run.status !== "success") {
      const structure = fixture.assertions().observations.map(item => `${String(item.httpStatus)}:${String(item.checkpoint ?? item.diagnostic ?? "unknown")}`).join(", ");
      throw new Error(`Pi agent publication ${run.status}; endpoint: ${structure}; tools: ${run.toolExecutions.map(tool => `${tool.name}:${tool.isError}`).join(", ")}`);
    }
    assert.equal(fixture.assertions().inferenceRequests, 4);
    assert.equal((await readPublishedIssue(gh.statePath)).title, "Pi agent publication");
    assert.equal(existsSync(join(fixture.workspace.projectRoot, path)), false);
    assert.equal(await readFile(join(fixture.workspace.projectRoot, foreign), "utf8"), content);
    const state = join(fixture.root, "harness-state", "issues");
    assert.deepEqual((await readdir(state)).filter(file => file.endsWith(".notice.json")), []);
    assert.equal((await rpc.prompt("Continue")).status, "success");
    assert.equal(fixture.assertions().inferenceRequests, 5);
    assert.deepEqual((await readdir(state)).filter(file => file.endsWith(".notice.json")), []);
    const calls = (JSON.parse(await readFile(gh.statePath, "utf8")) as { calls: string[][] }).calls;
    assert.equal(calls.filter(call => call[0] === "issue" && call[1] === "create" && !call.includes("--help")).length, 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-writers"], { scope });
    return { version: fixture.version, scope, inferenceRequests: 5 };
  } finally { await fixture.close(); }
}
