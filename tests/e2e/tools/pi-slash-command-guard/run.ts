import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

const marker = "[E2E:slash-command-guard]";

export async function runPiSlashCommandGuardJourney(scope: "project" | "user") {
  const fixture = await createPiFixture(createPiToolScenario({ name: "pi-slash-command-guard", marker, steps: [] }));
  try {
    const { workspace } = fixture;
    const root = await findHarnessRoot();
    const resources = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const extension = join(resources, "npm/node_modules/harness-pi-slash-command-guard/extensions/.harness-slash-command-guard/index.ts");
    const settings = join(workspace.projectRoot, ".pi/settings.json");
    const before = await readFile(settings, "utf8");
    await runFixtureInstaller(workspace, "install", ["slash-command-guard"], { scope, dryRun: true });
    await assert.rejects(access(extension));
    await runFixtureInstaller(workspace, "install", ["slash-command-guard", "clear-alias"], { scope });
    const repeat = await runFixtureInstaller(workspace, "install", ["slash-command-guard"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");

    const probe = join(workspace.projectRoot, ".pi/extensions/guard-probe/index.ts");
    await mkdir(dirname(probe), { recursive: true });
    await copyFile(join(root, "tests/e2e/tools/pi-slash-command-guard/probe.ts.txt"), probe);
    const skill = join(resources, "skills/guard-skill/SKILL.md");
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, `---\nname: guard-skill\ndescription: Fixture-only slash command resource.\ndisable-model-invocation: true\n---\n${marker}\n`);
    await writeFile(join(workspace.projectRoot, "guard-template.md"), `${marker}\n`);

    const rpc = fixture.rpc();
    const discovery = await rpc.request("get_commands");
    const names = (discovery.data as { commands: { name: string }[] }).commands.map(({ name }) => name);
    for (const name of ["clear", "guard-probe", "skill:guard-skill", "guard-template"]) assert.ok(names.includes(name));
    for (const text of ["/missing secret arguments", "/", "/skill:missing", "/guard-probe-typo", "/guard-template-typo", "/skill:guard-skill\nnot-arguments"]) {
      const result = await rpc.prompt(text);
      assert.equal(result.status, "handled");
      const notification = result.events.find((event) => event.type === "extension_ui_request" && event.method === "notify");
      assert.equal(notification?.message, `Command ${/^\/\S*/.exec(text)![0]} not found.`);
      assert.equal(notification?.notifyType, "error");
    }
    const messages = await rpc.request("get_messages");
    assert.deepEqual((messages.data as { messages: unknown[] }).messages, []);
    assert.equal(fixture.assertions().inferenceRequests, 0);
    const command = await rpc.prompt("/guard-probe arguments");
    assert.equal(command.status, "handled");
    assert.ok(command.events.some((event) => event.type === "entry_appended" &&
      (event.entry as { customType?: string })?.customType === "guard-probe"));
    const state = await rpc.request("get_state");
    assert.equal((await rpc.prompt("/clear")).status, "handled");
    const cleared = await rpc.request("get_state");
    assert.notEqual((cleared.data as { sessionId: string }).sessionId, (state.data as { sessionId: string }).sessionId);
    assert.equal((await rpc.prompt("/guard-reload")).status, "handled");
    assert.equal((await rpc.prompt("/still-missing")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 0);

    // These markers are supplied by native expansion, not by invocation arguments.
    for (const text of ["/skill:guard-skill", "/guard-template", "/guard-template\targuments", `${marker} discuss /missing`]) {
      assert.equal((await rpc.prompt("/clear")).status, "handled");
      assert.equal((await rpc.prompt(text)).status, "success");
    }
    assert.equal(fixture.assertions().inferenceRequests, 4);
    await rpc.close();
    const headless = await fixture.runJson({ prompt: "/missing" });
    // JSON mode has no RPC "handled" disposition or agent settlement for intercepted input.
    assert.ok(headless.eventTypes.includes("session"));
    assert.ok(!headless.eventTypes.some((type) => ["agent_start", "message_start", "extension_error"].includes(type)));
    assert.equal(fixture.assertions().inferenceRequests, 4);
    await runFixtureInstaller(workspace, "uninstall", ["slash-command-guard"], { scope });
    await assert.rejects(access(extension));
    await access(join(resources, "npm/node_modules/harness-pi-clear-alias/extensions/.harness-clear-alias/index.ts"));
    const remaining = JSON.parse(await readFile(settings, "utf8"));
    if (scope === "project") {
      assert.equal(remaining.packages.length, 1);
      assert.match(remaining.packages[0], /^npm:harness-pi-clear-alias@file:/u);
      delete remaining.packages;
    }
    assert.deepEqual(remaining, JSON.parse(before));
    const removed = fixture.rpc();
    assert.equal((await removed.prompt(`/missing ${marker}`)).status, "success");
    await removed.close();
    assert.equal(fixture.assertions().inferenceRequests, 5);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, inferenceRequests: 5 };
  } finally { await fixture.close(); }
}
