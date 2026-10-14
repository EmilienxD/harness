import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPiFixture } from "../../core/pi-fixture.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError } from "../../core/openai-server.js";
import { containsPath } from "../../core/path.js";
import { initializeRepository } from "../issues/support.js";

const exec = promisify(execFile);
const REPOSITORY = "EmilienxD/harness-e2e";
const gh = async (...args: string[]) => {
  try { return (await exec("gh", args, { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error("Live Pi GitHub fixture command failed"); }
};
const labels = async (): Promise<string[]> => (JSON.parse(await gh("label", "list", "--repo", REPOSITORY, "--limit", "200", "--json", "name")) as { name: string }[]).map((item) => item.name).sort();

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object" && "text" in value) return text(value.text);
  return "";
}

/** Real Pi + fake inference + real gh. Mutations stay in the exact private disposable repository. */
export async function runLivePiIssues(scope: "project" | "user") {
  assert.equal(await gh("api", "user", "--jq", ".login"), "EmilienxD");
  assert.deepEqual(JSON.parse(await gh("repo", "view", REPOSITORY, "--json", "nameWithOwner,isPrivate")), { nameWithOwner: REPOSITORY, isPrivate: true });
  const originalLabels = await labels();
  for (const name of ["[AI]-routine-difficulty", "[AI]-basic-difficulty", "[AI]-advanced-difficulty", "[AI]-expert-difficulty", "[AI]-afk", "[AI]-hitl", "[AI]-chrome"]) {
    assert.ok(originalLabels.includes(name), "Live Pi fixture requires the canonical seven labels; leave unprepared repositories untouched");
  }
  const prefix = `pi-issues-e2e-${randomUUID()}`;
  const titleParent = `${prefix} parent`;
  const titleChild = `${prefix} child`;
  const draftMarker = `[E2E:${prefix}:draft]`;
  const addressMarker = `[E2E:${prefix}:address]`;
  const reviewMarker = `[E2E:${prefix}:review]`;
  let parentNumber = 0;
  let childNumber = 0;
  const readScenario = (name: string, marker: string) => createPiToolScenario({ name, marker, steps: [
    { checkpoint: "write-observed-issue-data", tool: "write", input: { path: `${name}.json`, content: JSON.stringify({ parentNumber, childNumber }) + "\n" } },
  ] });
  const fixture = await createPiFixture({ scenarioCatalogHash: prefix, transition: (request) => {
    const userText = request.input.filter((item) => item.role === "user").map((item) => text(item.content)).join("\n");
    if (userText.includes(draftMarker)) {
      const destination = /Draft file path: (\S+)/.exec(userText)?.[1];
      if (!destination || !containsPath(fixture.workspace.projectRoot, join(fixture.workspace.projectRoot, destination))) throw new OpenAiProtocolError("$.input", "missing contained draft destination", "pi-live-issues");
      const match = /([0-9a-f-]{36})\.issue-(\d+)\.md$/.exec(destination);
      if (!match) throw new OpenAiProtocolError("$.input", "invalid draft identity", "pi-live-issues");
      const next = destination.replace(/issue-\d+\.md$/, `issue-${Number(match[2]) + 1}.md`);
      return createPiToolScenario({ name: "pi-live-draft", marker: draftMarker, steps: [
        { checkpoint: "draft-parent", tool: "write", input: { path: destination, content: `# ${titleParent}\n\n> difficulty:routine, mode:afk\n\nParent acceptance requirements.\n` } },
        { checkpoint: "draft-child", tool: "write", input: { path: next, content: `# ${titleChild}\n\n> difficulty:basic, mode:hitl\n\n## Parent\n\n${match[1]}/${match[2]}\n\n## Requirements\n\nImplement the parent requirements from ${match[1]}/${match[2]}.\n` } },
      ] }).transition(request);
    }
    const kind = userText.includes(addressMarker) ? "address" : userText.includes(reviewMarker) ? "review" : undefined;
    if (!kind) throw new OpenAiProtocolError("$.input", "unknown live issue fixture route", "pi-live-issues");
    // Parse structured source data, never assert agent instruction wording.
    const source = userText.split("\n").find((line) => line.startsWith('[{"') && line.includes('"sub_issues"'));
    if (!source) throw new OpenAiProtocolError("$.input", "missing complete GitHub issue data", "pi-live-issues");
    const documents = JSON.parse(source) as { number: number; parent: { number: number } | null; sub_issues: { number: number }[]; comments: { body: string }[] }[];
    const child = documents.find((item) => item.number === childNumber);
    const parent = documents.find((item) => item.number === parentNumber);
    if (!child || !parent || child.parent?.number !== parentNumber || !parent.sub_issues.some((item) => item.number === childNumber) || !child.comments.some((item) => item.body === `${prefix} maintainer acceptance comment`)) {
      throw new OpenAiProtocolError("$.input", "live GitHub relationships or comments missing", "pi-live-issues");
    }
    return readScenario(kind, kind === "address" ? addressMarker : reviewMarker).transition(request);
  } });
  const ownIssues = async (): Promise<{ number: number; title: string; state: string }[]> => (JSON.parse(await gh("issue", "list", "--repo", REPOSITORY, "--state", "all", "--limit", "100", "--json", "number,title,state")) as { number: number; title: string; state: string }[]).filter((item) => item.title === titleParent || item.title === titleChild);
  try {
    // Explicit GitHub credential handoff in memory only; personal model credentials remain excluded.
    fixture.workspace.env.GH_TOKEN = await gh("auth", "token", "--hostname", "github.com");
    fixture.workspace.env.GH_HOST = "github.com";
    const project = fixture.workspace.projectRoot;
    await writeFile(join(project, ".gitignore"), ".pi/\n.harness/\n");
    await writeFile(join(project, "baseline.txt"), "fixture\n");
    await initializeRepository(project);
    await exec("git", ["remote", "add", "origin", `https://github.com/${REPOSITORY}.git`], { cwd: project, windowsHide: true });
    await runFixtureInstaller(fixture.workspace, "install", ["issue-readers", "issue-writers"], { scope });
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    for (const [skill, marker] of [["draft-issues", draftMarker], ["address-this", addressMarker], ["review-this", reviewMarker]]) {
      const path = join(platform, "skills", skill!, "SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")) + `\n${marker}\n`);
    }
    const rpc = fixture.rpc({ timeoutMs: 180_000 });
    assert.equal((await rpc.prompt("/skill:draft-issues fixture batch", 60_000)).status, "success");
    assert.equal(fixture.assertions().inferenceRequests, 3);
    const drafts = join(project, ".harness", "issue-drafts");
    assert.equal((await readdir(drafts)).filter((file) => file.endsWith(".md")).length, 2);
    assert.equal((await rpc.prompt("/publish-issues --dry", 60_000)).status, "handled");
    assert.equal((await ownIssues()).length, 0);
    assert.deepEqual(await labels(), originalLabels);
    assert.equal((await rpc.prompt("/publish-issues", 120_000)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 3);
    // List without relying on search indexing after issue creation.
    const created = await ownIssues();
    assert.equal(created.length, 2);
    parentNumber = created.find((item) => item.title === titleParent)!.number;
    childNumber = created.find((item) => item.title === titleChild)!.number;
    const child = JSON.parse(await gh("issue", "view", String(childNumber), "--repo", REPOSITORY, "--json", "body,labels")) as { body: string; labels: { name: string }[] };
    assert.equal(child.body.trim(), `## Requirements\n\nImplement the parent requirements from #${parentNumber}.`);
    assert.deepEqual(child.labels.map((label) => label.name).sort(), ["[AI]-basic-difficulty", "[AI]-hitl"]);
    assert.deepEqual(await readdir(drafts), [".gitignore"]);
    assert.equal((await rpc.prompt("/publish-issues", 60_000)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 3);
    await gh("issue", "comment", String(childNumber), "--repo", REPOSITORY, "--body", `${prefix} maintainer acceptance comment`);
    // JSON addressing + RPC review both use real gh GraphQL in the shipped Python helpers.
    assert.equal((await fixture.runJson({ prompt: `/skill:address-this ${childNumber}` })).status, "success");
    assert.equal(await readFile(join(project, "address.json"), "utf8"), JSON.stringify({ parentNumber, childNumber }) + "\n");
    assert.equal((await fixture.rpc().prompt(`/skill:review-this https://github.com/${REPOSITORY}/issues/${childNumber}`, 120_000)).status, "success");
    assert.equal(await readFile(join(project, "review.json"), "utf8"), JSON.stringify({ parentNumber, childNumber }) + "\n");
    assert.equal((await fixture.rpc().prompt(`/skill:address-this ${childNumber}`)).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 7);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["issue-writers", "issue-readers"], { scope });
    await assert.rejects(access(join(platform, "hooks", "pi-support", "workflows.ts")));
    return { version: fixture.version, scope, repository: REPOSITORY, publishedIssues: [parentNumber, childNumber], inferenceRequests: 7, publishInferenceRequests: 0 };
  } finally {
    try {
      // Only this UUID-tagged run's issues and the gateway's newly added spec label are ours.
      for (const issue of await ownIssues()) {
        if (issue.state === "OPEN") await gh("issue", "close", String(issue.number), "--repo", REPOSITORY);
      }
      assert.ok((await ownIssues()).every((issue) => issue.state === "CLOSED"), "Live Pi run left an owned issue open");
      if (!originalLabels.includes("[AI]-spec") && (await labels()).includes("[AI]-spec")) await gh("label", "delete", "[AI]-spec", "--repo", REPOSITORY, "--yes");
      assert.deepEqual(await labels(), originalLabels);
    } finally {
      delete fixture.workspace.env.GH_TOKEN;
      await fixture.close();
    }
  }
}
