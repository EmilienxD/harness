import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runFixtureInstaller } from "../core/installer.js";
import { createPiFixture } from "../core/pi-fixture.js";
import { createPiToolScenario } from "../core/pi-scenario.js";
import { stagePiProbe } from "../tools/pi-smoke/run.js";

test("Pi compaction uses the fake API and preserves tool execution and guard denial", { timeout: 90_000 }, async () => {
  const scenario = createPiToolScenario({ name: "pi-compaction", marker: "[E2E:compaction]", steps: [
    { checkpoint: "blocked-write", tool: "write", input: { path: "blocked.txt", content: "must not exist\n" } },
    { checkpoint: "allowed-write", tool: "write", input: { path: "compacted.txt", content: "after compaction\n" } },
  ] });
  const fixture = await createPiFixture({
    scenarioCatalogHash: scenario.scenarioCatalogHash,
    transition: (request) => {
      if (request.tools.length === 0) {
        assert.equal(request.model, "pi-e2e");
        assert.ok(request.input.length > 0);
        return { scenario: "pi-compaction", checkpoint: "summary", output: {
          type: "message", id: "msg_compaction_summary", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "The fixture is ready to continue.", annotations: [] }],
        } };
      }
      const start = request.input.reduce((index, item, current) => item.role === "user" ? current : index, 0);
      return scenario.transition({ ...request, input: request.input.slice(start) });
    },
  });
  try {
    const { workspace } = fixture;
    await stagePiProbe(workspace.projectRoot);
    const settingsPath = join(workspace.agentDir, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.compaction.keepRecentTokens = 0;
    await writeFile(settingsPath, JSON.stringify(settings));
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("[E2E:compaction]")).status, "success");
    const before = fixture.assertions().inferenceRequests;
    const compacted = await rpc.request("compact");
    assert.equal(compacted.success, true);
    assert.equal(fixture.assertions().inferenceRequests, before + 1);
    assert.ok(fixture.assertions().checkpoints.includes("summary"));
    const entries = await rpc.request("get_entries");
    assert.ok((entries.data as { entries: { type: string }[] }).entries.some((entry) => entry.type === "compaction"));
    const run = await rpc.prompt("[E2E:compaction]");
    assert.equal(run.status, "success");
    assert.deepEqual(run.toolExecutions, [{ name: "write", isError: true }, { name: "write", isError: false }]);
    assert.equal(await readFile(join(workspace.projectRoot, "compacted.txt"), "utf8"), "after compaction\n");
    await assert.rejects(readFile(join(workspace.projectRoot, "blocked.txt")));
    assert.equal(fixture.assertions().inferenceRequests, 7);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});

test("resuming Pi restores selected tools, activates newly installed tools and preserves exclusions", { timeout: 90_000 }, async () => {
  const restored = { checkpoint: "restored-tool", tool: "restored_probe", input: {} };
  const late = { checkpoint: "new-tool", tool: "late_probe", input: {} };
  const initial = createPiToolScenario({ name: "pi-resume-tools", marker: "[E2E:resume-tools]", steps: [] });
  const selected = createPiToolScenario({ name: "pi-resume-tools", marker: "[E2E:resume-tools]", steps: [restored] });
  const resumed = createPiToolScenario({ name: "pi-resume-tools", marker: "[E2E:resume-tools]", steps: [late] });
  const fixture = await createPiFixture({
    scenarioCatalogHash: `${initial.scenarioCatalogHash}:${selected.scenarioCatalogHash}:${resumed.scenarioCatalogHash}`,
    transition: (request) => {
      const userOffsets = request.input.flatMap((item, index) => item.role === "user" ? [index] : []);
      const turns = userOffsets.length;
      assert.ok(turns >= 1 && turns <= 3, "Unexpected resume journey phase");
      const continuation = turns > 2;
      const names = request.tools.map((tool) => tool.name);
      assert.ok(names.includes("restored_probe"));
      assert.equal(names.includes("removed_probe"), turns === 1);
      for (const name of ["inactive_probe", "grep", "powershell", "codemode", "find", "ls"]) {
        assert.ok(!names.includes(name), "Inactive and excluded tools must stay unavailable");
      }
      assert.equal(names.includes("late_probe"), continuation);
      // Each turn has its own tool history; retain the real conversation for Pi,
      // but route the fixture from the most recent user turn.
      const start = userOffsets.at(-1)!;
      const scenario = continuation ? resumed : turns === 1 ? initial : selected;
      return scenario.transition({ ...request, input: request.input.slice(start) });
    },
  });
  try {
    const { workspace } = fixture;
    await runFixtureInstaller(workspace, "install", ["exclude-unwanted-tools"]);
    const extensions = join(workspace.projectRoot, ".pi", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(join(extensions, "loadout.ts"), `
import {writeFileSync} from "node:fs";
import {join} from "node:path";
export default function(pi) {
  for (const [name, defaultActive] of [["restored_probe", false], ["removed_probe", true], ["inactive_probe", false], ["grep", true]]) {
    pi.registerTool({name, label:name, description:"Resume acceptance probe", defaultActive,
      parameters:{type:"object", properties:{}},
      async execute(_id, _input, _signal, _update, ctx) {
        writeFileSync(join(ctx.cwd, name + ".txt"), name);
        return {content:[{type:"text", text:"Probe completed"}]};
      }});
  }
  pi.registerCommand("select-loadout", {description:"Select fixture tools", handler:async () => {
    pi.setActiveTools(["read", "write", "edit", "restored_probe", "removed_probe", "grep"]);
  }});
  pi.registerCommand("remove-probe", {description:"Remove a recorded fixture tool", handler:async () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== "removed_probe"));
  }});
}
`);
    const rpc = fixture.rpc();
    assert.equal((await rpc.prompt("/select-loadout")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal((await rpc.prompt("[E2E:resume-tools]")).status, "success");
    assert.equal((await rpc.prompt("/remove-probe")).status, "handled");
    assert.equal((await rpc.prompt("[E2E:resume-tools]")).status, "success");
    assert.equal(await readFile(join(workspace.projectRoot, "restored_probe.txt"), "utf8"), "restored_probe");
    await rpc.close();
    const files = await readdir(workspace.sessionsDir);
    assert.equal(files.length, 1);
    await writeFile(join(extensions, "late.ts"), `
import {writeFileSync} from "node:fs";
import {join} from "node:path";
export default function(pi) {
  pi.registerTool({name:"late_probe", label:"Late probe", description:"Newly installed resume probe",
    parameters:{type:"object", properties:{}},
    async execute(_id, _input, _signal, _update, ctx) {
      writeFileSync(join(ctx.cwd, "late_probe.txt"), "late_probe");
      return {content:[{type:"text", text:"Probe completed"}]};
    }});
}
`);
    const run = await fixture.runJson({ prompt: "[E2E:resume-tools]", sessionFile: join(workspace.sessionsDir, files[0]!) });
    assert.equal(run.status, "success", JSON.stringify(fixture.assertions().observations));
    assert.deepEqual(run.toolExecutions, [{ name: "late_probe", isError: false }]);
    assert.equal(await readFile(join(workspace.projectRoot, "late_probe.txt"), "utf8"), "late_probe");
    for (const name of ["removed_probe", "inactive_probe", "grep"]) {
      await assert.rejects(readFile(join(workspace.projectRoot, `${name}.txt`)));
    }
    assert.equal(fixture.assertions().inferenceRequests, 5);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
  } finally { await fixture.close(); }
});
