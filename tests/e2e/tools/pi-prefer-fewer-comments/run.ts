import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario, type PiScenarioStep } from "../../core/pi-scenario.js";

const comments = "# First explanation.\n# Second explanation.\n# Third explanation.\n";
const oldInline = `value = 1  # ${"existing commentary ".repeat(20)}\n`;
const policy = 'version = 1\n[limits]\nmax_comment_lines = 2\n[[rules]]\npatterns = ["vendor/**"]\nexempt = true\n[[rules]]\npatterns = ["vendor/ours/**"]\nexempt = false\n';

export async function runPiCommentsJourney(mode: "json" | "rpc", scope: "project" | "user") {
  const marker = `[E2E:pi-comments-${mode}-${scope}]`;
  const multiline = "const value = `\n// String one\n// String two\n// String three\n`;\n";
  const ratio = Array.from({ length: 7 }, (_, i) => `# Rationale ${i}\nvalue_${i} = ${i}\n`).join("") + Array.from({ length: 6 }, (_, i) => `extra_${i} = ${i}\n`).join("");
  const bom = "\ufeffvalue = 1\r\n";
  const steps: PiScenarioStep[] = [
    { checkpoint: "unchanged-overwrite", tool: "write", input: { path: "existing.py", content: comments + "value = 1\n" } },
    { checkpoint: "unchanged-inline", tool: "edit", input: { path: "inline.py", edits: [{ oldText: "value = 1", newText: "value = 2" }] } },
    { checkpoint: "old-adjacent-block", tool: "edit", input: { path: "existing.py", edits: [{ oldText: "value = 1", newText: "# Short addition.\nvalue = 2" }] } },
    { checkpoint: "multiline-template", tool: "write", input: { path: "literal.ts", content: multiline } },
    { checkpoint: "native-write-reminder", tool: "write", input: { path: "new.py", content: comments + "value = 1\n" } },
    { checkpoint: "cooldown", tool: "edit", input: { path: "new.py", edits: [{ oldText: "value = 1", newText: "# Fourth explanation.\nvalue = 2" }] } },
    { checkpoint: "failed-edit", tool: "edit", input: { path: "absent.py", edits: [{ oldText: "absent", newText: comments }] } },
    { checkpoint: "exemption", tool: "write", input: { path: "vendor/library.py", content: comments } },
    { checkpoint: "reinclude", tool: "write", input: { path: "vendor/ours/library.py", content: comments } },
    { checkpoint: "docstring", tool: "write", input: { path: "doc.py", content: 'def work():  # Public entry.\n    """\n' + "    Contract line.\n".repeat(6) + '    """\n    return 1\n' } },
    { checkpoint: "header-budget", tool: "write", input: { path: "header.py", content: '"""\n' + "Purpose line.\n".repeat(6) + '"""\nvalue = 1\n' } },
    { checkpoint: "header-over-budget", tool: "write", input: { path: "long_header.py", content: '"""\n' + "Purpose line.\n".repeat(16) + '"""\nvalue = 1\n' } },
    { checkpoint: "directive", tool: "write", input: { path: "directive.py", content: "# pragma: " + "machine setting ".repeat(30) + "\nvalue = 1\n" } },
    { checkpoint: "density", tool: "write", input: { path: "ratio.py", content: ratio } },
    { checkpoint: "multiline-context", tool: "edit", input: { path: "context.ts", edits: [{ oldText: "old wording", newText: "brief wording" }] } },
    { checkpoint: "bom-crlf-native-path", tool: "edit", input: { path: "@bom.py", edits: [{ oldText: "value = 1", newText: comments + "value = 2" }] } },
    { checkpoint: "bounded-advisory-failure", tool: "write", input: { path: "large.py", content: "x".repeat(512 * 1024 + 1) } },
    { checkpoint: "multi-edit", tool: "edit", input: { path: "multi.py", edits: [{ oldText: "first = 1", newText: comments + "first = 2" }, { oldText: "second = 1", newText: "second = 2" }] } },
    { checkpoint: "outside-project-first-file", tool: "write", input: { path: "../outside/shared.py", content: comments } },
    { checkpoint: "outside-project-distinct-file", tool: "write", input: { path: "../other/shared.py", content: comments } },
  ];
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-comments", marker, steps }));
  try {
    const project = fixture.workspace.projectRoot;
    await writeFile(join(project, "existing.py"), comments + "value = 1\n");
    await writeFile(join(project, "inline.py"), oldInline);
    await writeFile(join(project, "context.ts"), "/*\n * first line\n * old wording\n * third line\n */\nconst x = 1;\n");
    await writeFile(join(project, "bom.py"), bom);
    await writeFile(join(project, "multi.py"), "first = 1\nsecond = 1\n");
    await runFixtureInstaller(fixture.workspace, "install", ["prefer-fewer-comments"], { scope, dryRun: true });
    const platform = scope === "project" ? join(project, ".pi") : fixture.workspace.agentDir;
    assert.equal(existsSync(join(platform, "extensions", "harness-prefer-fewer-comments")), false);
    await runFixtureInstaller(fixture.workspace, "install", ["prefer-fewer-comments"], { scope });
    const starter = scope === "project" ? join(project, ".harness", "guards", "prefer-fewer-comments.toml") : join(platform, "hooks", "prefer-fewer-comments.toml");
    await writeFile(starter, scope === "project" ? policy : "version = 1\n[limits]\nmax_comment_lines = 9\n");
    await mkdir(join(project, ".harness", "guards"), { recursive: true });
    await writeFile(join(project, ".harness", "guards", "prefer-fewer-comments.toml"), policy);
    await runFixtureInstaller(fixture.workspace, "install", ["prefer-fewer-comments"], { scope });
    const run = mode === "json" ? await fixture.runJson({ prompt: marker }) : await fixture.rpc().prompt(marker);
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions()));
    const ends = run.events.filter((event) => event.type === "tool_execution_end");
    assert.deepEqual(ends.map((event) => (event.result as { content: unknown[] }).content.length), [1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 1, 2, 1, 2, 2, 2, 2, 2, 2, 2]);
    assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), steps.map((_, i) => i === 6));
    assert.equal(await readFile(join(project, "existing.py"), "utf8"), comments + "# Short addition.\nvalue = 2\n");
    assert.equal(await readFile(join(project, "inline.py"), "utf8"), oldInline.replace("value = 1", "value = 2"));
    assert.equal(await readFile(join(project, "literal.ts"), "utf8"), multiline);
    assert.equal(await readFile(join(project, "new.py"), "utf8"), comments + "# Fourth explanation.\nvalue = 2\n");
    assert.equal(await readFile(join(project, "bom.py"), "utf8"), "\ufeff" + (comments + "value = 2\n").replaceAll("\n", "\r\n"));
    assert.equal(await readFile(join(project, "multi.py"), "utf8"), comments + "first = 2\nsecond = 2\n");
    assert.equal(await readFile(join(project, "ratio.py"), "utf8"), ratio);
    assert.equal(await readFile(join(fixture.root, "outside", "shared.py"), "utf8"), comments);
    assert.equal(await readFile(join(fixture.root, "other", "shared.py"), "utf8"), comments);
    assert.equal((await readFile(join(project, "large.py"))).length, 512 * 1024 + 1);
    const details = (ends[17]!.result as { details: { patch: string; diff: string } }).details;
    assert.equal(typeof details.patch, "string");
    assert.equal(typeof details.diff, "string");
    const files = await readdir(fixture.workspace.sessionsDir);
    const entries = (await readFile(join(fixture.workspace.sessionsDir, files[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const receipts = entries.filter((entry) => entry.type === "custom" && entry.customType === "harness-prefer-fewer-comments-v1");
    assert.equal(receipts.length, 10);
    assert.ok(receipts.every((entry) => Object.keys(entry.data).sort().join(",") === "callId,launchArgv,receipts"));
    assert.equal(fixture.assertions().inferenceRequests, steps.length + 1);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["prefer-fewer-comments"], { scope });
    await assert.rejects(access(join(platform, "extensions", "harness-prefer-fewer-comments", "index.ts")));
    await assert.rejects(access(join(platform, "hooks", "pi-transport", "transport.ts")));
    assert.equal(await readFile(starter, "utf8"), scope === "project" ? policy : "version = 1\n[limits]\nmax_comment_lines = 9\n");
    return { version: fixture.version, mode, scope, inferenceRequests: steps.length + 1, status: run.status };
  } finally { await fixture.close(); }
}

export async function runPiCommentsStateJourney() {
  const marker = "[E2E:pi-comments-state]";
  const scenario = createPiToolScenario({ name: "pi-comments-state", marker, steps: [
    { checkpoint: "parallel-nested-writes", tool: "comments_probe", input: {} },
  ] });
  const continuing = ["cooldown", "branch", "resume"].map((name) => ({ marker: `[E2E:pi-comments-${name}]`, scenario: createPiToolScenario({
    name: `pi-comments-${name}`, marker: `[E2E:pi-comments-${name}]`, steps: [
      { checkpoint: name, tool: "comments_again", input: {} },
    ],
  }) }));
  const fixture = await createPiFixture({ ...scenario, transition: (request) => {
    // Each explicit user turn has its own closed scenario. Keep its entire call
    // history; unrelated earlier turns do not become steps in this workflow.
    for (const route of [...continuing].reverse()) {
      const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes(route.marker) ? current : last, -1);
      if (index >= 0) return route.scenario.transition({ ...request, input: request.input.slice(index) });
    }
    return scenario.transition(request);
  } });
  try {
    const project = fixture.workspace.projectRoot;
    await runFixtureInstaller(fixture.workspace, "install", ["prefer-fewer-comments", "on-edit-reminder", "on-edit-block"]);
    await writeFile(join(project, ".harness", "guards", "on-edit-reminder.toml"), 'version = 1\n[[rules]]\npatterns = ["parallel.py"]\nrequire = ["guide.md"]\n');
    await writeFile(join(project, ".harness", "guards", "on-edit-block.toml"), 'version = 1\n[[rules]]\npatterns = ["denied.py"]\nrequire = ["guide.md"]\n');
    await writeFile(join(project, "guide.md"), "Conventions.\n");
    const probe = join(project, ".pi", "extensions", "comments-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), await readFile(join(await findHarnessRoot(), "tests", "e2e", "tools", "pi-prefer-fewer-comments", "state-probe.ts.txt")));
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/comments-anchor")).status, "handled");
    const first = await rpc.prompt(marker);
    assert.equal(first.status, "success");
    assert.deepEqual(first.toolExecutions.map((tool) => ({ name: tool.name, isError: tool.isError })), [
      { name: "write", isError: true }, { name: "write", isError: false }, { name: "write", isError: false },
      { name: "write", isError: false }, { name: "edit", isError: false }, { name: "comments_probe", isError: false },
    ]);
    const counts = JSON.parse(await readFile(join(project, "counts.json"), "utf8"));
    assert.deepEqual({ ...counts, parallel: undefined }, { denied: true, parallel: undefined, secondFile: 2, unchanged: 1 });
    // The separate edit reminder may race its own cooldown between siblings;
    // comment cooldown and comment receipts must still be serialized exactly.
    assert.ok(counts.parallel.every((count: number) => count >= 1 && count <= 3));
    assert.ok(counts.parallel.reduce((total: number, count: number) => total + count, 0) >= 4);
    assert.equal(await readFile(join(project, "parallel.py"), "utf8"), comments + "value = 1\n");
    assert.equal(existsSync(join(project, "denied.py")), false);
    assert.equal((await rpc.prompt("/comments-inspect")).status, "handled");
    const before = JSON.parse(await readFile(join(project, "receipts.json"), "utf8"));
    assert.equal(before.count, 2);
    assert.equal(before.nested, true);
    assert.equal((await rpc.prompt("/comments-reload")).status, "handled");
    assert.equal((await rpc.prompt("/comments-inspect")).status, "handled");
    assert.deepEqual(JSON.parse(await readFile(join(project, "receipts.json"), "utf8")), before);
    assert.equal((await rpc.prompt(continuing[0]!.marker)).status, "success");
    assert.equal(JSON.parse(await readFile(join(project, "again.json"), "utf8")).count, 1);
    assert.equal((await rpc.prompt("/comments-back")).status, "handled");
    assert.equal((await rpc.prompt("/comments-inspect")).status, "handled");
    assert.equal(JSON.parse(await readFile(join(project, "receipts.json"), "utf8")).count, 0);
    assert.equal((await rpc.prompt(continuing[1]!.marker)).status, "success");
    assert.equal(JSON.parse(await readFile(join(project, "again.json"), "utf8")).count, 2);
    assert.equal(fixture.assertions().inferenceRequests, 6);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await rpc.close();
    const files = await readdir(fixture.workspace.sessionsDir);
    assert.equal((await fixture.runJson({ prompt: continuing[2]!.marker, sessionFile: join(fixture.workspace.sessionsDir, files[0]!) })).status, "success");
    assert.equal(JSON.parse(await readFile(join(project, "again.json"), "utf8")).count, 1);
    assert.equal(fixture.assertions().inferenceRequests, 8);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["prefer-fewer-comments"]);
    await access(join(project, ".pi", "hooks", "pi-transport", "transport.ts"));
    await runFixtureInstaller(fixture.workspace, "uninstall", ["on-edit-reminder", "on-edit-block"]);
    await assert.rejects(access(join(project, ".pi", "hooks", "pi-transport", "transport.ts")));
  } finally { await fixture.close(); }
}

export async function runPiCommentsRecoveryJourney() {
  const routes = [
    { name: "helper-outage", path: "recover.py", content: comments },
    { name: "helper-recovery", path: "recover.py", content: comments.replaceAll("explanation.", "renewed explanation.") },
    { name: "zero-budget", path: "zero.py", content: "# Short rationale.\nvalue = 1\n" },
    { name: "zero-header", path: "zero_header.py", content: '"""Module purpose."""\nvalue = 1\n' },
    { name: "new-session", path: "zero.py", content: "# Changed rationale.\nvalue = 2\n" },
  ].map((route) => ({ ...route, marker: `[E2E:pi-comments-${route.name}]`, scenario: createPiToolScenario({
    name: route.name, marker: `[E2E:pi-comments-${route.name}]`, steps: [{ checkpoint: route.name, tool: "write", input: { path: route.path, content: route.content } }],
  }) }));
  const fixture = await createPiFixture({ ...routes[0]!.scenario, transition: (request) => {
    for (const route of [...routes].reverse()) {
      const index = request.input.reduce((last, item, current) => item.role === "user" && JSON.stringify(item.content).includes(route.marker) ? current : last, -1);
      if (index >= 0) return route.scenario.transition({ ...request, input: request.input.slice(index) });
    }
    return routes[0]!.scenario.transition(request);
  } });
  try {
    const project = fixture.workspace.projectRoot;
    await runFixtureInstaller(fixture.workspace, "install", ["prefer-fewer-comments"]);
    const helper = join(project, ".pi", "hooks", "prefer_fewer_comments_pi.py");
    await rename(helper, helper + ".disabled");
    const rpc = fixture.rpc();
    for (let index = 0; index < routes.length; index++) {
      if (index === 1) await rename(helper + ".disabled", helper);
      if (index === 2) await writeFile(join(project, ".harness", "guards", "prefer-fewer-comments.toml"), 'version = 1\n[limits]\nmax_comment_lines = 0\nmax_doc_lines = 0\nmax_header_lines = 0\n');
      if (index === 4) assert.equal((await rpc.request("new_session")).success, true);
      const route = routes[index]!;
      const run = await rpc.prompt(route.marker);
      assert.equal(run.status, "success");
      assert.deepEqual(run.toolExecutions.map((tool) => tool.isError), [false]);
      const end = run.events.find((event) => event.type === "tool_execution_end")!;
      assert.equal((end.result as { content: unknown[] }).content.length, 2);
      assert.equal(await readFile(join(project, route.path), "utf8"), route.content);
      const files = await readdir(fixture.workspace.sessionsDir);
      const entries = (await Promise.all(files.map((file) => readFile(join(fixture.workspace.sessionsDir, file), "utf8")))).flatMap((content) => content.trim().split("\n").map((line) => JSON.parse(line)));
      assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "harness-prefer-fewer-comments-v1").length, index);
    }
    assert.equal(fixture.assertions().inferenceRequests, routes.length * 2);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
}
