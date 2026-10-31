import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLaunchConfigurationSource } from "../../src/platform/launch-configuration.js";

test("launch validates only the selected provider/profile and warns about unrelated errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");
  const source = new FileLaunchConfigurationSource(path);
  await writeFile(path, JSON.stringify({ version: 1, autoRun: { provider: "pi" }, loop: { maxFeedback: -1 }, providers: { claude: { interactive: { effort: "broken" } }, pi: { interactive: { model: "sonnet" }, autoRun: { review: { effort: "broken" } } } } }));
  assert.equal((await source.getFor("pi", "interactive")).platform, "pi");
  assert.equal((await source.get("interactive")).platform, "pi");
  assert.ok((await source.load({ platform: "pi", type: "interactive" })).diagnostics.length > 0);
  await assert.rejects(source.getFor("pi", "review"), /effort/);
  await assert.rejects(source.getFor("claude", "interactive"), /effort/);
});
