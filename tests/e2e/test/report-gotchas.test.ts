import assert from "node:assert/strict";
import test from "node:test";

import { runReportGotchasJourney } from "../tools/report-gotchas/run.js";

const live = process.env.HARNESS_REPORT_GOTCHAS_LIVE_E2E === "1";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`report-gotchas sends one real ${cliName} report to Discord`, { skip: !live }, async () => {
    const result = await runReportGotchasJourney(platform);
    assert.deepEqual(result.checkpoints, ["skill-loaded", "report-submitted", "complete"]);
    assert.equal(result.delivered, true);
    assert.equal(result.inferenceRequests, 3);
    assert.equal(result.unexpectedRequests, 0);
  });
}
