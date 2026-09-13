import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLauncherJourney } from "../tools/agent-launcher/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`agent-launcher applies project configuration to the real ${platform} CLI request`, async () => {
    const result = await runAgentLauncherJourney(platform);
    assert.deepEqual(result.checkpoints, ["configuration-observed"]);
    assert.equal(result.unexpectedRequests, 0);
  });
}
