import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../core/installer.js";
import { createPiFixture } from "../core/pi-fixture.js";
import { createPiToolScenario } from "../core/pi-scenario.js";
import { PiRpcClient } from "../core/pi.js";
import { spawnableCommand } from "../core/path.js";

test("native Pi packages select the project copy once and restore the user copy on removal", { timeout: 120_000 }, async () => {
  const fixture = await createPiFixture(createPiToolScenario({
    name: "package-precedence", marker: "[E2E:package-precedence]",
    steps: [{ checkpoint: "selected-tool", tool: "scope_probe", input: {} }],
  }));
  try {
    const catalogueRoot = join(fixture.root, "catalogue");
    const toolRoot = join(catalogueRoot, "harness", "probes", "scope-probe");
    await mkdir(toolRoot, { recursive: true });
    await cp(join(await findHarnessRoot(), "harness/productivity/clear-alias"),
      join(catalogueRoot, "harness/productivity/clear-alias"), { recursive: true });
    await runFixtureInstaller(fixture.workspace, "install", ["clear-alias"], { scope: "user", catalogueRoot });
    for (const scope of ["user", "project"] as const) {
      await writeFile(join(toolRoot, "harness.toml"), `name = "scope-probe"
version = "${scope === "user" ? "1.0.0" : "2.0.0"}"
description = "Pi resource scope acceptance probe"
[platforms.pi]
status = "supported"
[[files]]
src = "extension.ts"
dest = ".harness-scope-probe/index.ts"
root = "extensions"
`);
      await writeFile(join(toolRoot, "extension.ts"), `
import {appendFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => appendFileSync(join(ctx.cwd, "scope-hooks.log"), "${scope}\\n"));
  pi.registerTool({name:"scope_probe",label:"Scope probe",description:"Resource scope acceptance probe",
    parameters:{type:"object",properties:{}},
    async execute(_id, _params, _signal, _update, ctx) {
      writeFileSync(join(ctx.cwd,"scope-tool.txt"),"${scope}");
      return {content:[{type:"text",text:"${scope}"}]};
    }});
  pi.registerCommand("scope-probe", {description:"Inspect selected scope",handler:async (_args,ctx) => {
    writeFileSync(join(ctx.cwd,"scope-command.txt"),"${scope}");
  }});
  pi.registerCommand("scope-reload", {description:"Reload resources",handler:async (_args,ctx) => {await ctx.reload();}});
}
`);
      await runFixtureInstaller(fixture.workspace, "install", ["scope-probe"], { scope, catalogueRoot });
    }
    const updateCommand = spawnableCommand("pi", ["update", "--extensions", "--approve"]);
    const updating = promisify(execFile)(updateCommand.file, [...updateCommand.args], {
      cwd: fixture.workspace.projectRoot,
      env: { ...fixture.workspace.env, PI_OFFLINE: "0", npm_config_offline: "true", npm_config_audit: "false", npm_config_ignore_scripts: "true" },
      encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    updating.child.stdin?.end();
    await updating;
    const read = (name: string) => readFile(join(fixture.workspace.projectRoot, name), "utf8");
    await writeFile(join(fixture.workspace.agentDir, "extensions", "user-extra.ts"), `
import {writeFileSync} from "node:fs";
import {join} from "node:path";
export default function(pi) {pi.registerCommand("user-extra", {description:"User-only resource",
handler:async (_args,ctx) => writeFileSync(join(ctx.cwd,"user-extra.txt"),"present")});}
`);
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/scope-probe")).status, "handled");
    assert.equal(await read("scope-command.txt"), "project");
    assert.equal(await read("scope-hooks.log"), "project\n");
    assert.equal((await rpc.prompt("/scope-reload")).status, "handled");
    assert.equal((await rpc.prompt("/scope-probe")).status, "handled");
    assert.equal(await read("scope-hooks.log"), "project\nproject\n");
    assert.equal((await rpc.prompt("/user-extra")).status, "handled");
    assert.equal(await read("user-extra.txt"), "present");
    await rpc.close();
    assert.equal((await fixture.runJson({ prompt: "[E2E:package-precedence]" })).status, "success");
    assert.equal(await read("scope-tool.txt"), "project");

    const checkout = join(fixture.root, "checkout");
    await cp(join(fixture.workspace.projectRoot, ".pi"), join(checkout, ".pi"), { recursive: true });
    const copied = new PiRpcClient({ ...fixture.workspace, projectRoot: checkout });
    try {
      assert.equal((await copied.prompt("/scope-probe")).status, "handled");
      assert.equal(await readFile(join(checkout, "scope-command.txt"), "utf8"), "project");
      assert.equal(await readFile(join(checkout, "scope-hooks.log"), "utf8"), "project\n");
    } finally { await copied.close(); }

    // An explicit project disable suppresses the package; an untrusted project
    // cannot suppress the user's package. Neither case may run two handlers.
    const settingsPath = join(fixture.workspace.projectRoot, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    await writeFile(settingsPath, JSON.stringify({ ...settings, packages: [
      { source: settings.packages[0], extensions: [] },
    ] }));
    const disabled = fixture.rpc();
    const commands = await disabled.request("get_commands");
    assert.equal((commands.data as { commands: { name: string }[] }).commands.some((entry) => entry.name === "scope-probe"), false);
    assert.equal((await disabled.prompt("/user-extra")).status, "handled");
    await disabled.close();
    assert.equal(await read("scope-hooks.log"), "project\nproject\nproject\n");
    const command = spawnableCommand("pi", ["--mode", "json", "--print", "--offline", "--no-approve", "--no-mcp",
      "--no-prompt-templates", "--no-themes", "--model", "harness-e2e/pi-e2e",
      "--session-dir", fixture.workspace.sessionsDir, "--", "/scope-probe"]);
    const untrusted = promisify(execFile)(command.file, [...command.args], {
      cwd: fixture.workspace.projectRoot, env: fixture.workspace.env,
      encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    untrusted.child.stdin?.end();
    await untrusted;
    assert.equal(await read("scope-command.txt"), "user");
    await writeFile(settingsPath, JSON.stringify(settings));

    await runFixtureInstaller(fixture.workspace, "uninstall", ["scope-probe"], { scope: "project", catalogueRoot });
    const npmProject = JSON.parse(await readFile(join(fixture.workspace.projectRoot, ".pi/npm/package.json"), "utf8"));
    assert.equal(npmProject.dependencies?.["harness-pi-scope-probe"], undefined);
    const user = fixture.rpc();
    assert.equal((await user.prompt("/scope-probe")).status, "handled");
    assert.equal(await read("scope-command.txt"), "user");
    await user.close();
    assert.equal((await fixture.runJson({ prompt: "[E2E:package-precedence]" })).status, "success");
    assert.equal(await read("scope-tool.txt"), "user");
    assert.equal(await read("scope-hooks.log"), "project\nproject\nproject\nuser\nuser\nuser\n");
    await runFixtureInstaller(fixture.workspace, "uninstall", ["scope-probe"], { scope: "user", catalogueRoot });
    const npmUser = JSON.parse(await readFile(join(fixture.workspace.agentDir, "npm/package.json"), "utf8"));
    assert.equal(npmUser.dependencies?.["harness-pi-scope-probe"], undefined);
    assert.match(npmUser.dependencies["harness-pi-clear-alias"], /^file:/u);
    for (const name of ["package-lock.json", "node_modules/.package-lock.json"]) {
      const lock = JSON.parse(await readFile(join(fixture.workspace.agentDir, "npm", name), "utf8"));
      assert.equal(lock.packages["node_modules/harness-pi-scope-probe"], undefined);
      assert.ok(lock.packages["node_modules/harness-pi-clear-alias"]);
    }
    assert.equal(fixture.assertions().inferenceRequests, 4);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});
