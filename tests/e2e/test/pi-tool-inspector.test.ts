import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runFixtureInstaller } from "../core/installer.js";
import { createPiFixture } from "../core/pi-fixture.js";
import { createPiToolScenario } from "../core/pi-scenario.js";

for (const scope of ["project", "user"] as const) {
  test(`real Pi ${scope} tool inspector reports contracts without inference and removes cleanly`, { timeout: 90_000 }, async () => {
    const fixture = await createPiFixture(createPiToolScenario({ name: "pi-tool-inspector", marker: "[E2E:tool-inspector]", steps: [] }));
    try {
      const { workspace } = fixture;
      await runFixtureInstaller(workspace, "install", ["tool-inspector"], { scope });
      const rpc = fixture.rpc();
      const commands = await rpc.request("get_commands");
      assert.ok((commands.data as { commands: { name: string }[] }).commands.some((command) => command.name === "tools"));
      const single = await rpc.prompt("/tools read");
      const all = await rpc.prompt("/tools");
      assert.equal(single.status, "handled");
      assert.equal(all.status, "handled");
      const messages = await rpc.request("get_messages");
      assert.deepEqual((messages.data as { messages: unknown[] }).messages, []);
      await rpc.close();
      const entries = [...single.events, ...all.events]
        .filter((event) => event.type === "entry_appended").map((event) => event.entry as { type: string; customType?: string; data: { text: string } });
      const reports = entries.filter((entry) => entry.type === "custom" && entry.customType === "harness-tool-inspector:report");
      assert.equal(reports.length, 2);
      assert.ok(reports[0]!.data.text.includes("path: string (required)"));
      assert.ok(!reports[0]!.data.text.includes('"properties"'));
      assert.ok(reports[0]!.data.text.includes("No output schema exposed"));
      const restarted = fixture.rpc();
      assert.equal((await restarted.prompt("/tools write")).status, "handled");
      await restarted.close();
      assert.equal(fixture.assertions().inferenceRequests, 0);
      assert.equal(fixture.assertions().unexpectedRequests, 0);
      await runFixtureInstaller(workspace, "uninstall", ["tool-inspector"], { scope });
      const base = scope === "project" ? join(workspace.projectRoot, ".pi") : workspace.agentDir;
      await assert.rejects(access(join(base, "extensions/.harness-tool-inspector/index.ts")));
    } finally { await fixture.close(); }
  });
}
