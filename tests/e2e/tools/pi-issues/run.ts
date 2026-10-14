import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createPiFixture } from "../../core/pi-fixture.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { containsPath } from "../../core/path.js";
import { createFakeGh, initializeRepository, readPublishedIssue } from "../issues/support.js";

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
    for (const skill of ["address-this", "review-this"]) {
      const path = join(platform, "skills", skill, "SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")) + `\n${marker}\n`);
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
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-readers"], { scope });
    // User-owned starter bodies survive receipt removal.
    await access(join(platform, "skills", "address-this", "SKILL.md"));
    await assert.rejects(access(join(platform, "hooks", "pi-support", "workflows.ts")));
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
  const fixture = await createPiFixture({ scenarioCatalogHash: scenarios[0]!.scenarioCatalogHash, transition: (request) => {
    const serialized = JSON.stringify(request.input);
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
    for (const scenario of scenarios) {
      const skill = join(platform, "skills", scenario.name, "SKILL.md");
      await writeFile(skill, (await readFile(skill, "utf8")) + `\n[E2E:pi-${scenario.name}]\n`);
    }
    const probe = join(fixture.workspace.projectRoot, ".pi", "extensions", "issue-test-lifecycle");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), 'export default function(pi) { pi.registerCommand("e2e-issue-reload", { handler: async (_args, ctx) => { await ctx.reload(); } }); }');
    const rpc = fixture.rpc({ sessionId });
    assert.equal((await rpc.prompt("/skill:draft-issue fixture")).status, "success");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, path), "utf8"), content);
    assert.equal((await rpc.prompt("/e2e-issue-reload")).status, "handled");
    const foreign = `.harness/issue-drafts/${draftSession(randomUUID())}.issue-0.md`;
    await writeFile(join(fixture.workspace.projectRoot, foreign), content);
    assert.equal((await fixture.rpc().prompt("/publish-issues")).status, "handled");
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { issues: unknown[] }).issues.length, 0);
    assert.equal((await rpc.prompt("/publish-issues --unknown")).status, "handled");
    assert.equal((await rpc.prompt("/skill:publish-issues --dry")).status, "handled");
    assert.equal(await readFile(join(fixture.workspace.projectRoot, path), "utf8"), content);
    assert.equal((JSON.parse(await readFile(gh.statePath, "utf8")) as { issues: unknown[] }).issues.length, 0);
    assert.equal((await rpc.prompt("/publish-issues")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 2);
    assert.equal((await readPublishedIssue(gh.statePath)).title, "Pi fixture issue");
    await assert.rejects(access(join(fixture.workspace.projectRoot, path)));
    assert.deepEqual(await readdir(join(fixture.workspace.projectRoot, ".harness", "issue-drafts")), [".gitignore", foreign.split("/").at(-1)!].sort());
    for (const scenario of scenarios.slice(1)) {
      assert.equal((await fixture.runJson({ prompt: `/skill:${scenario.name} fixture` })).status, "success");
    }
    assert.equal(fixture.assertions().inferenceRequests, 5);
    await unlink(join(platform, "hooks", "issue_writers_pi.py"));
    assert.equal((await rpc.prompt("/skill:draft-issues fixture")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-writers"], { scope });
    await access(join(platform, "hooks", "pi-support", "workflows.ts"));
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-readers"], { scope });
    await assert.rejects(access(join(platform, "hooks", "pi-support", "workflows.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, inferenceRequests: 5 };
  } finally { await fixture.close(); }
}
