import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { marker, scenario } from "./scenario.js";

export async function runPiDocumentsJourney(mode: "json" | "rpc", scope: "project" | "user") {
  const fixture = await createPiFixture(scenario());
  try {
    const project = fixture.workspace.projectRoot;
    const platformRoot = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    const policy = scope === "project" ? join(project, ".harness/guards/no-new-documents.toml") : join(platformRoot, "harness/no-new-documents.toml");
    const draft = (path: string) => join(project, ".harness/doc-drafts", path);
    const shell = process.platform === "win32" ? "powershell" : "bash";
    await writeFile(join(project, ".pi/settings.json"), JSON.stringify({ defaultProvider: "harness-e2e", defaultModel: "pi-e2e", defaultTools: ["read", "write", "edit", shell] }));
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs/existing.md"), "original existing\n");
    await runFixtureInstaller(fixture.workspace, "install", ["no-new-documents"], { scope, dryRun: true });
    assert.equal(existsSync(join(platformRoot, "npm/node_modules/harness-pi-no-new-documents/extensions/.harness-no-new-documents/index.ts")), false);
    await runFixtureInstaller(fixture.workspace, "install", ["no-new-documents"], { scope });
    const customPolicy = 'version = 1\nprotected = ["**/docs/**"]\n# preserved customization\n';
    await writeFile(policy, customPolicy);
    await runFixtureInstaller(fixture.workspace, "install", ["no-new-documents"], { scope });
    assert.equal(await readFile(policy, "utf8"), customPolicy);
    const probe = join(project, ".pi/extensions/documents-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), await readFile(join(await findHarnessRoot(), "tests/e2e/tools/pi-no-new-documents/probe.ts.txt")));
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/documents-anchor")).status, "handled");
    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await rpc.prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    assert.deepEqual(run.events.filter((event) => event.type === "tool_execution_end" && !event.parentToolCallId).map((event) => event.isError), [true, false, false, true, true, false, false, false, false, false]);
    assert.equal(existsSync(join(project, "docs/new.md")), false);
    assert.equal(existsSync(join(project, "docs/shell.md")), false);
    assert.equal(existsSync(join(project, "docs/nested/new.md")), false);
    assert.equal(await readFile(draft("docs/new.md"), "utf8"), "approved content\n");
    assert.deepEqual(JSON.parse(await readFile(join(project, "nested-result.json"), "utf8")), { denied: true, draft: false });
    assert.equal(await readFile(join(project, "docs/existing.md"), "utf8"), "updated existing\n");
    assert.equal(await readFile(join(project, "result.txt"), "utf8"), "ordinary file\n");
    assert.equal(await readFile(draft(".gitignore"), "utf8"), "*\n");
    assert.equal(fixture.assertions().inferenceRequests, 11);
    for (const command of ["/approve-doc-draft", "/reject-doc-draft docs/reject.md", '/approve-doc-draft "docs/space name.md"', "/approve-doc-draft docs/existing.md", "/approve-doc-draft docs/new.md", "/approve-doc-draft docs/nested"]) {
      assert.equal((await rpc.prompt(command)).status, "handled");
    }
    assert.equal(fixture.assertions().inferenceRequests, 11);
    assert.equal(existsSync(draft("docs/reject.md")), false);
    assert.equal(existsSync(join(project, "docs/reject.md")), false);
    assert.equal(await readFile(join(project, "docs/space name.md"), "utf8"), "quoted content\n");
    assert.equal(await readFile(join(project, "docs/new.md"), "utf8"), "approved content\n");
    assert.equal(await readFile(join(project, "docs/nested/new.md"), "utf8"), "nested content\n");
    assert.equal(await readFile(join(project, "docs/existing.md"), "utf8"), "updated existing\n");
    assert.equal(await readFile(draft("docs/existing.md"), "utf8"), "keep draft\n");
    assert.equal((await rpc.prompt("/documents-inspect")).status, "handled");
    const notices = JSON.parse(await readFile(join(project, "notice-count.json"), "utf8"));
    assert.equal(notices.outcomes, 4);
    assert.equal((await rpc.prompt("/documents-reload")).status, "handled");
    assert.equal((await rpc.prompt("/documents-inspect")).status, "handled");
    assert.deepEqual(JSON.parse(await readFile(join(project, "notice-count.json"), "utf8")), notices);
    // This native session had no model history in JSON mode; request the marker so its scenario starts.
    if (mode === "rpc") {
      assert.equal((await rpc.prompt("Continue.")).status, "success");
      assert.equal((await rpc.prompt("/documents-inspect")).status, "handled");
      assert.equal(JSON.parse(await readFile(join(project, "notice-count.json"), "utf8")).pending, 1);
      const files = await readdir(fixture.workspace.sessionsDir);
      assert.equal(files.length, 1);
      assert.equal((await fixture.runJson({ prompt: "Continue.", sessionFile: join(fixture.workspace.sessionsDir, files[0]!) })).status, "success");
      assert.equal(fixture.assertions().inferenceRequests, 13);
    }
    assert.equal((await rpc.prompt("/documents-back")).status, "handled");
    assert.equal((await rpc.prompt("/documents-inspect")).status, "handled");
    assert.deepEqual(JSON.parse(await readFile(join(project, "notice-count.json"), "utf8")), { outcomes: 0, pending: 0 });
    // Filesystem approvals are final, even when conversation ancestry changes.
    assert.equal(await readFile(join(project, "docs/new.md"), "utf8"), "approved content\n");
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    const composition = mode === "rpc" && scope === "project";
    if (composition) {
      await runFixtureInstaller(fixture.workspace, "install", ["cleanup-git"], { scope });
      assert.equal((await rpc.prompt("/documents-reload")).status, "handled");
      const discovered = await rpc.request("get_commands");
      const commands = (discovered.data as { commands: { name: string; source: string }[] }).commands;
      assert.ok(commands.some((command) => command.name === "skill:cleanup-git" && command.source === "skill"));
    }
    await runFixtureInstaller(fixture.workspace, "uninstall", ["no-new-documents"], { scope });
    await assert.rejects(access(join(platformRoot, "npm/node_modules/harness-pi-no-new-documents/extensions/.harness-no-new-documents/index.ts")));
    if (composition) {
      await access(join(platformRoot, "npm/node_modules/harness-pi-pi-transport/harness/pi-transport/transport.ts"));
      await runFixtureInstaller(fixture.workspace, "uninstall", ["cleanup-git"], { scope });
    }
    await assert.rejects(access(join(platformRoot, "npm/node_modules/harness-pi-pi-transport/harness/pi-transport/transport.ts")));
    assert.equal(await readFile(policy, "utf8"), customPolicy);
    return { version: fixture.version, mode, scope, inferenceRequests: fixture.assertions().inferenceRequests };
  } finally { await fixture.close(); }
}

export async function runPiDocumentsSafetyJourney() {
  const marker = "[E2E:pi-documents-invalid-policy]";
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-documents-invalid-policy", marker, steps: [
    { checkpoint: "invalid-policy-denies-write", tool: "write", input: { path: "docs/invalid.md", content: "forbidden\n" } },
    { checkpoint: "invalid-policy-denies-existing-write", tool: "write", input: { path: "existing.txt", content: "forbidden\n" } },
  ] }));
  try {
    const project = fixture.workspace.projectRoot;
    const drafts = join(project, ".harness/doc-drafts");
    await runFixtureInstaller(fixture.workspace, "install", ["no-new-documents"]);
    const policy = join(project, ".harness/guards/no-new-documents.toml");
    await writeFile(policy, "broken [ TOML\n");
    await writeFile(join(project, "existing.txt"), "before\n");
    const run = await fixture.runJson({ prompt: marker });
    assert.equal(run.status, "success");
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [true, true]);
    assert.equal(existsSync(join(project, "docs/invalid.md")), false);
    assert.equal(await readFile(join(project, "existing.txt"), "utf8"), "before\n");
    await writeFile(policy, 'version = 1\nprotected = ["**/docs/**"]\n');
    const probe = join(project, ".pi/extensions/documents-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), await readFile(join(await findHarnessRoot(), "tests/e2e/tools/pi-no-new-documents/probe.ts.txt")));
    // A destination ancestor that redirects outside the project cannot publish a draft.
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(drafts, "escape"), { recursive: true });
    await writeFile(join(drafts, "escape/new.md"), "stay draft\n");
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/approve-doc-draft escape/new.md")).status, "handled");
    assert.equal(existsSync(join(outside, "new.md")), false);
    assert.equal(await readFile(join(drafts, "escape/new.md"), "utf8"), "stay draft\n");
    await symlink(outside, join(drafts, "outside"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(outside, "foreign.md"), "foreign\n");
    assert.equal((await rpc.prompt("/reject-doc-draft outside")).status, "handled");
    assert.equal(await readFile(join(outside, "foreign.md"), "utf8"), "foreign\n");
    // Two actual Pi processes race through the same exclusive publication primitive.
    await mkdir(join(drafts, "docs"));
    await writeFile(join(drafts, "docs/auto.md"), "requires user command\n");
    assert.equal((await rpc.prompt("/documents-auto-approve")).status, "handled");
    assert.equal((await rpc.prompt("/documents-inspect")).status, "handled");
    assert.equal(existsSync(join(project, "docs/auto.md")), false);
    assert.equal(await readFile(join(drafts, "docs/auto.md"), "utf8"), "requires user command\n");
    assert.equal(JSON.parse(await readFile(join(project, "notice-count.json"), "utf8")).outcomes, 0);
    // Native extension command dispatch intentionally runs before input events.
    // Trusted extensions have full filesystem access and are not a guard boundary.
    await writeFile(join(drafts, "docs/dispatch.md"), "trusted dispatch\n");
    assert.equal((await rpc.prompt("/documents-dispatch-approve")).status, "handled");
    const dispatchDeadline = Date.now() + 5000;
    while (!existsSync(join(project, "docs/dispatch.md")) && Date.now() < dispatchDeadline) await delay(20);
    assert.equal(await readFile(join(project, "docs/dispatch.md"), "utf8"), "trusted dispatch\n");
    // Neither a linked draft subtree nor a linked draft root may select foreign files.
    await symlink(join(drafts, "docs"), join(drafts, "alias"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await rpc.prompt("/reject-doc-draft alias/auto.md")).status, "handled");
    assert.equal(await readFile(join(drafts, "docs/auto.md"), "utf8"), "requires user command\n");
    await rename(drafts, `${drafts}-saved`);
    await symlink(outside, drafts, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await rpc.prompt("/reject-doc-draft foreign.md")).status, "handled");
    assert.equal((await rpc.prompt("/approve-doc-draft foreign.md")).status, "handled");
    assert.equal(await readFile(join(outside, "foreign.md"), "utf8"), "foreign\n");
    assert.equal(existsSync(join(project, "foreign.md")), false);
    await unlink(drafts);
    await rename(`${drafts}-saved`, drafts);
    await writeFile(join(drafts, "docs/race.md"), "published once\n");
    const second = fixture.rpc();
    const commands = await Promise.all([rpc.prompt("/approve-doc-draft docs/race.md"), second.prompt("/approve-doc-draft docs/race.md")]);
    assert.deepEqual(commands.map((result) => result.status), ["handled", "handled"]);
    assert.equal(await readFile(join(project, "docs/race.md"), "utf8"), "published once\n");
    assert.equal(existsSync(join(drafts, "docs/race.md")), false);
    let outcomeCount = 0;
    for (const client of [rpc, second]) {
      assert.equal((await client.prompt("/documents-inspect")).status, "handled");
      outcomeCount += JSON.parse(await readFile(join(project, "notice-count.json"), "utf8")).outcomes;
    }
    assert.equal(outcomeCount, 2);
    assert.equal(fixture.assertions().inferenceRequests, 3);
    // Missing installed transport must deny native calls and consume commands without inference.
    await unlink(join(project, ".pi/npm/node_modules/harness-pi-no-new-documents/harness/no_new_documents_pi.py"));
    const unavailable = await fixture.runJson({ prompt: marker });
    assert.equal(unavailable.status, "success");
    assert.deepEqual(unavailable.toolExecutions.map((tool) => tool.isError), [true, true]);
    assert.equal(existsSync(join(project, "docs/invalid.md")), false);
    assert.equal(await readFile(join(project, "existing.txt"), "utf8"), "before\n");
    assert.equal((await rpc.prompt("/approve-doc-draft docs/auto.md")).status, "handled");
    assert.equal(await readFile(join(drafts, "docs/auto.md"), "utf8"), "requires user command\n");
    assert.equal(fixture.assertions().inferenceRequests, 6);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
}

export async function runPiDocumentsPathsJourney(scope: "project" | "user") {
  const marker = "[E2E:pi-documents-native-paths]";
  let selected: ReturnType<typeof createPiToolScenario> | undefined;
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-documents-native-paths-v1", transition: (request) => {
    assert.ok(selected, "path scenario must be prepared before inference");
    return selected.transition(request);
  } });
  try {
    const project = fixture.workspace.projectRoot;
    const outside = join(fixture.root, "outside");
    const drafts = join(project, ".harness/doc-drafts");
    await runFixtureInstaller(fixture.workspace, "install", ["no-new-documents"], { scope });
    await mkdir(join(project, "docs"));
    await mkdir(outside);
    await writeFile(join(project, "docs/existing.md"), "before\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(project, "docs"), join(project, "alias"), linkType);
    await symlink(outside, join(project, "docs/external"), linkType);
    await mkdir(drafts, { recursive: true });
    await symlink(outside, join(drafts, "linked"), linkType);
    const denied = [
      { path: "@docs/at.md", actual: join(project, "docs/at.md") },
      { path: "@./docs/dot.md", actual: join(project, "docs/dot.md") },
      { path: "docs/space\u202fname.md", actual: join(project, "docs/space name.md") },
      { path: "~/../project/docs/home.md", actual: join(project, "docs/home.md") },
      { path: pathToFileURL(join(project, "docs/url.md")).href, actual: join(project, "docs/url.md") },
      { path: "alias/alias.md", actual: join(project, "docs/alias.md") },
      { path: "docs/external/logical.md", actual: join(outside, "logical.md") },
      { path: ".harness/doc-drafts/linked/escape.md", actual: join(outside, "escape.md") },
    ];
    if (process.platform === "win32") {
      denied.push({ path: "DOCS/case.md", actual: join(project, "docs/case.md") });
      const absolute = project.replaceAll("\\", "/");
      const drive = absolute[0]!.toLowerCase();
      for (const prefix of ["", "mnt/", "cygdrive/"]) {
        const name = `${prefix.replace("/", "") || "msys"}.md`;
        denied.push({ path: `/${prefix}${drive}${absolute.slice(2)}/docs/${name}`, actual: join(project, "docs", name) });
      }
    }
    selected = createPiToolScenario({ name: "pi-documents-native-paths", marker, steps: [
      ...denied.map(({ path }, index) => ({ checkpoint: `deny-path-${index}`, tool: "write", input: { path, content: "forbidden\n" } })),
      { checkpoint: "alias-existing-write", tool: "write", input: { path: "@docs/existing.md", content: "after\n" } },
      { checkpoint: "alias-existing-edit", tool: "edit", input: { path: "@docs/existing.md", oldText: "after", newText: "edited" } },
      { checkpoint: "alias-unprotected-write", tool: "write", input: { path: "@ordinary.txt", content: "ordinary\n" } },
      { checkpoint: "single-at-expansion", tool: "write", input: { path: "@@literal.txt", content: "literal\n" } },
      { checkpoint: "alias-draft-write", tool: "write", input: { path: "@.harness/doc-drafts/docs/approved.md", content: "reviewed\n" } },
    ] });
    const run = await fixture.runJson({ prompt: marker });
    assert.equal(run.status, "success");
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [...denied.map(() => true), false, false, false, false, false]);
    for (const { actual } of denied) assert.equal(existsSync(actual), false);
    assert.equal(await readFile(join(project, "docs/existing.md"), "utf8"), "edited\n");
    assert.equal(await readFile(join(project, "ordinary.txt"), "utf8"), "ordinary\n");
    assert.equal(await readFile(join(project, "@literal.txt"), "utf8"), "literal\n");
    assert.equal(existsSync(join(project, "literal.txt")), false);
    assert.equal(await readFile(join(drafts, "docs/approved.md"), "utf8"), "reviewed\n");
    assert.equal(await readFile(join(drafts, ".gitignore"), "utf8"), "*\n");
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/approve-doc-draft docs/approved.md")).status, "handled");
    assert.equal(await readFile(join(project, "docs/approved.md"), "utf8"), "reviewed\n");
    assert.equal(existsSync(join(drafts, "docs/approved.md")), false);
    assert.equal(fixture.assertions().inferenceRequests, denied.length + 6);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, deniedPaths: denied.length, inferenceRequests: fixture.assertions().inferenceRequests };
  } finally { await fixture.close(); }
}
