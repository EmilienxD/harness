import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";

const marker = "[E2E:environment-context]";

export async function runPiEnvironmentContextJourney(scope: "project" | "user") {
  const fixture = await createPiFixture(createPiToolScenario({
    name: "pi-environment-context", marker,
    steps: [{ checkpoint: "receipt", tool: "write", input: { path: "receipt.txt", content: "verified\n" } }],
  }));
  try {
    const { workspace } = fixture;
    const resources = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const extension = join(resources, "extensions/.harness-environment-context/index.ts");
    const settings = join(resources, "settings.json");
    const originalSettings = JSON.parse(await readFile(settings, "utf8"));
    await runFixtureInstaller(workspace, "install", ["environment-context"], { scope, dryRun: true });
    await assert.rejects(access(extension));
    await runFixtureInstaller(workspace, "install", ["environment-context"], { scope });
    const repeat = await runFixtureInstaller(workspace, "install", ["environment-context"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");

    // Observe final section metadata at agent_start, independent of extension loading order.
    const probe = join(workspace.projectRoot, ".pi/extensions/zz-environment-probe/index.ts");
    await mkdir(dirname(probe), { recursive: true });
    await copyFile(join(await findHarnessRoot(), "tests/e2e/tools/pi-environment-context/probe.ts.txt"), probe);
    const checkProbe = (events: readonly Readonly<Record<string, unknown>>[], installed: boolean) => {
      const entries = events.filter((event) => event.type === "entry_appended")
        .map((event) => event.entry as { customType?: string; data?: Record<string, unknown> })
        .filter((entry) => entry.customType === "environment-context-probe");
      assert.equal(entries.length, 1);
      const data = entries[0]!.data!;
      const names = data.sectionNames as string[];
      assert.equal(names.includes("environment"), installed);
      assert.equal(names.includes("git_snapshot"), installed);
      assert.equal(names.includes("session_start_time"), false);
      assert.equal(Number(data.environmentLength) > 0, installed);
      assert.equal(Number(data.gitLength) > 0, installed);
      assert(Number(data.gitLength) < 2200);
      assert(Number.isFinite(Date.parse(String(data.sessionTimestamp))));
      return data.sessionTimestamp;
    };

    // Initially not a Git repository: JSON uses the actual installed extension.
    const json = await fixture.runJson({ prompt: marker });
    assert.equal(json.status, "success");
    checkProbe(json.events, true);
    assert.equal(await readFile(join(workspace.projectRoot, "receipt.txt"), "utf8"), "verified\n");

    // Real local Git with enough untracked files to truncate; no GitHub remote needed.
    await promisify(execFile)("git", ["init", "--quiet", workspace.projectRoot], { env: workspace.env });
    for (let i = 0; i < 20; i++) await writeFile(join(workspace.projectRoot, `new-${i}.txt`), "fixture\n");
    const rpc = fixture.rpc();
    const first = await rpc.prompt(marker);
    assert.equal(first.status, "success");
    const timestamp = checkProbe(first.events, true);
    assert.equal((await rpc.prompt("/environment-reload")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 4);
    const second = await rpc.prompt(marker);
    assert.equal(second.status, "success");
    assert.equal(checkProbe(second.events, true), timestamp);
    await rpc.close();
    assert.equal(fixture.assertions().inferenceRequests, 5);

    await runFixtureInstaller(workspace, "uninstall", ["environment-context"], { scope });
    await assert.rejects(access(extension));
    await access(probe);
    const remaining = JSON.parse(await readFile(settings, "utf8"));
    // Receipt removal omits an empty packages list; both forms mean no packages.
    assert.deepEqual(remaining.packages ?? [], originalSettings.packages ?? []);
    delete remaining.packages;
    delete originalSettings.packages;
    assert.deepEqual(remaining, originalSettings);
    const removed = await fixture.runJson({ prompt: marker });
    assert.equal(removed.status, "success");
    checkProbe(removed.events, false);
    assert.equal(fixture.assertions().inferenceRequests, 7);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope, inferenceRequests: 7 };
  } finally { await fixture.close(); }
}
