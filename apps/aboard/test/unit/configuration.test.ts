import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ABOARD_SETTINGS, createLayeredReader, parseProjectSettings, readAboardConfiguration } from "../../src/configuration.js";

test("interactive resumes keep fork as default and accept the terminal reuse setting", () => {
  assert.equal(readAboardConfiguration({ get: () => undefined }).value.interactiveResumeMode, "fork");
  const project = parseProjectSettings('{"sessions":{"interactiveResumeMode":"reuse-terminal"}}');
  const result = readAboardConfiguration(createLayeredReader({ user: { get: () => undefined }, project: project.values }));
  assert.equal(result.value.interactiveResumeMode, "reuse-terminal");
  assert.equal(result.diagnostics.length + project.diagnostics.length, 0);
  const invalid = readAboardConfiguration({ get: (key) => key === "aboard.sessions.interactiveResumeMode" ? "invalid" : undefined });
  assert.equal(invalid.value.interactiveResumeMode, "fork");
  assert.equal(invalid.diagnostics.length, 1);
});

test("configuration validates retained settings and uses conservative fallbacks", () => {
  const values = new Map<string, unknown>([
    ["aboard.bridge.port", 70_000],
    ["aboard.launch.maxInlinePromptChars", -1],
    ["aboard.autoRun.mergeStrategy", "cherry-pick"],
    ["aboard.autoRun.review", "yes"],
  ]);
  const result = readAboardConfiguration({ get: (key) => values.get(key) });
  assert.equal(result.value.bridgePort, 4823);
  assert.equal(result.value.maxInlinePromptChars, 4000);
  assert.equal(result.value.autoRun.mergeStrategy, "squash");
  assert.equal(result.value.autoRun.review, false);
  assert.equal(result.diagnostics.length, 4);
});

test("project settings accept retained nested settings and ignore unknown fields", () => {
  const result = parseProjectSettings(JSON.stringify({
    launch: { maxInlinePromptChars: 6000 },
    autoRun: { mergeStrategy: "rebase" },
    obsolete: { removed: true },
  }));
  assert.deepEqual(Object.fromEntries(result.values), {
    "aboard.launch.maxInlinePromptChars": 6000,
    "aboard.autoRun.mergeStrategy": "rebase",
  });
  assert.equal(result.diagnostics.length, 1);

  const layered = readAboardConfiguration(createLayeredReader({
    user: { get: (key) => key === "aboard.bridge.port" ? 6000 : undefined },
    workspace: { get: (key) => key === "aboard.bridge.port" ? 7000 : undefined },
    project: result.values,
  }));
  assert.equal(layered.value.bridgePort, 7000);
  assert.equal(layered.value.autoRun.mergeStrategy, "rebase");
});

test("every contributed setting is listed in ABOARD_SETTINGS", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, unknown> } } };
  assert.deepEqual([...ABOARD_SETTINGS].sort(), Object.keys(manifest.contributes.configuration.properties).sort());
});
