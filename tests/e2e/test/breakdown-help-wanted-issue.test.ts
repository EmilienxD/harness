import assert from "node:assert/strict";
import test from "node:test";

import { runBreakdownHelpWantedIssueJourney } from "../tools/breakdown-help-wanted-issue/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  const cliName = platform === "claude" ? "Claude Code" : "Codex";
  test(`breakdown-help-wanted-issue investigates the oldest fallback issue through real ${cliName}`, async () => {
    const result = await runBreakdownHelpWantedIssueJourney(platform);
    assert.deepEqual(result.checkpoints, ["inspect-current-behavior", "report-complete"]);
    assert.match(result.report, /Request and purpose/iu);
    assert.match(result.report, /Current behavior and evidence/iu);
    assert.match(result.report, /Proposed scope/iu);
    assert.match(result.report, /Blockers and open decisions/iu);
    assert.match(result.report, /Recommendation/iu);
    assert.match(result.report, /validate or correct/iu);
    assert.equal(result.githubMutations, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
}
