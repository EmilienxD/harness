import assert from "node:assert/strict";
import test from "node:test";
import { readAboardConfiguration } from "../src/configuration.js";

test("configuration validates untrusted values and reports actionable fallbacks", () => {
  const values = new Map<string, unknown>([
    ["aboard.bridge.port", 70_000],
    ["aboard.launch.maxInlinePromptChars", -1],
    ["aboard.manager.toolPreset", "writer"],
    ["aboard.manager.disallowedTools", ["Read", ""]],
    ["aboard.workers.permissionMode", "unsafe"],
    ["aboard.review.autoReview", true],
    ["aboard.timeouts.managerStop", 0],
  ]);
  const result = readAboardConfiguration({ get: (key) => values.get(key) });
  assert.equal(result.value.bridgePort, 4823);
  assert.equal(result.value.maxInlinePromptChars, 4000);
  assert.equal(result.value.managerToolPreset, "read-only");
  assert.deepEqual(result.value.managerDisallowedTools, []);
  assert.equal(result.value.workerPermissionMode, "default");
  assert.equal(result.value.autoReview, "never");
  assert.equal(result.value.managerStopTimeoutSeconds, 3600);
  assert.equal(result.diagnostics.length, 7);
  assert.ok(result.diagnostics.every((item) => item.message.includes(item.setting)));
});

test("configuration accepts every supported launch and review setting", () => {
  const values: Record<string, unknown> = {
    "aboard.bridge.port": 0,
    "aboard.launch.maxInlinePromptChars": 12_000,
    "aboard.manager.toolPreset": "delegation-only",
    "aboard.manager.disallowedTools": ["Bash", "Read(./src/**)"],
    "aboard.workers.permissionMode": "bypass",
    "aboard.review.autoReview": "hitl",
    "aboard.timeouts.managerStop": 7200,
    "aboard.timeouts.managerPrompt": 45,
    "aboard.timeouts.managerSessionStart": 90,
  };
  const result = readAboardConfiguration({ get: (key) => values[key] });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value.bridgePort, 0);
  assert.equal(result.value.managerToolPreset, "delegation-only");
  assert.deepEqual(result.value.managerDisallowedTools, ["Bash", "Read(./src/**)"]);
  assert.equal(result.value.autoReview, "hitl");
});
