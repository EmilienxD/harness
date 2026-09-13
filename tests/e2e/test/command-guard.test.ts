import assert from "node:assert/strict";
import test from "node:test";

import { runCommandGuardJourney } from "../tools/command-guard/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`command-guard lets a safe command run and blocks a dangerous command in the real ${platform} CLI`, async () => {
    const result = await runCommandGuardJourney(platform);
    assert.deepEqual(result.checkpoints, ["safe-command", "dangerous-command-denied", "complete"]);
    assert.equal(result.allowedBytes, "allowed\n");
    assert.equal(result.deniedMarkerExists, false);
    assert.match(result.finalText, /command-guard denied the dangerous command/iu);
    assert.equal(result.unexpectedRequests, 0);
  });
}
