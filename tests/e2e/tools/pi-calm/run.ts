import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { spawnableCommand } from "../../core/path.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { contents, marker, scenario } from "./scenario.js";

const exec = promisify(execFile);

async function piPackageRoot(): Promise<string> {
  const command = spawnableCommand("pi", []);
  let root = dirname(await realpath(command.args[0] ?? command.file));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return root;
    } catch { /* ascend from the CLI entry to its package */ }
    const parent = dirname(root);
    if (parent === root) throw new Error("Calm rendering checks require Pi's installed npm SDK");
    root = parent;
  }
}

export async function runPiCalmJourney(scope: "project" | "user") {
  const fixture = await createPiFixture(scenario);
  try {
    const { workspace } = fixture;
    const resources = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
    const extension = join(resources, "extensions", ".harness-calm", "index.ts");
    const preference = join(workspace.agentDir, "calm");
    const settings = join(workspace.projectRoot, ".pi", "settings.json");
    const before = await readFile(settings, "utf8");
    await runFixtureInstaller(workspace, "install", ["calm"], { scope, dryRun: true });
    await assert.rejects(access(extension));
    await runFixtureInstaller(workspace, "install", ["calm"], { scope });
    await access(join(dirname(extension), "LICENSE"));
    const repeat = await runFixtureInstaller(workspace, "install", ["calm"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    const rpc = fixture.rpc();
    const discovery = await rpc.request("get_commands");
    assert.ok((discovery.data as { commands: { name: string }[] }).commands.some(({ name }) => name === "calm"));
    await assert.rejects(access(preference));
    assert.equal((await rpc.prompt("/calm")).status, "handled");
    assert.equal(await readFile(preference, "utf8"), "on\n");
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal((await rpc.prompt(marker)).status, "success");
    assert.equal(await readFile(join(workspace.projectRoot, "calm-result.txt"), "utf8"), contents);
    assert.equal(fixture.assertions().inferenceRequests, 3);
    await rpc.close();
    const restarted = fixture.rpc();
    assert.equal((await restarted.prompt("/calm")).status, "handled");
    assert.equal(await readFile(preference, "utf8"), "off\n");
    assert.equal((await restarted.prompt("/calm")).status, "handled");
    assert.equal(await readFile(preference, "utf8"), "on\n");
    await restarted.close();

    const harnessRoot = await findHarnessRoot();
    for (const flags of [[], ["--legacy-renderer"]]) {
      await exec(process.execPath, [join(harnessRoot, "tests/e2e/tools/pi-calm/render-check.mjs"),
        await piPackageRoot(), extension,
        join(harnessRoot, "harness/productivity/web-toolkit/pi/extension.ts"),
        join(harnessRoot, "harness/productivity/background-shell/pi/extension.ts"), ...flags], {
        cwd: workspace.projectRoot, env: workspace.env, windowsHide: true, timeout: 30_000,
      });
    }
    assert.equal(fixture.assertions().inferenceRequests, 3);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(workspace, "uninstall", ["calm"], { scope });
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), JSON.parse(before));
    await assert.rejects(access(extension));
    assert.equal(await readFile(preference, "utf8"), "on\n");
    return { version: fixture.version, scope, inferenceRequests: 3 };
  } finally { await fixture.close(); }
}
