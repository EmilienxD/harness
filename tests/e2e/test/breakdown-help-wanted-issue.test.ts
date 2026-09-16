import assert from "node:assert/strict";
import test from "node:test";

import { runBreakdownHelpWantedIssueJourney } from "../tools/breakdown-help-wanted-issue/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`breakdown-help-wanted-issue investigates a supplied request through real ${cliName}`, async () => {
    const result = await runBreakdownHelpWantedIssueJourney(platform);
    assert.deepEqual(result.checkpoints, ["inspect-current-behavior", "report-complete"]);
    assert.ok(result.report.trim());
    assert.equal(result.unexpectedRequests, 0);
  });
}
