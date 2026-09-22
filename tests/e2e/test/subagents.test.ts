import assert from "node:assert/strict";
import test from "node:test";

import { runSubagentsJourney } from "../tools/subagents/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
 for (const mode of ["interactive","auto"] as const) {
  test(`subagents delegates and explicitly replies through real ${platform} ${mode} CLIs`, { timeout: 180_000 }, async () => {
    const result = await runSubagentsJourney(platform,mode);
    assert.deepEqual(result.checkpoints.filter((item) => item !== "parent-waiting").sort(), ["child-complete", ...(mode === "interactive" ? ["child-reply-armed", "child-resume-reply-armed"] : []), "child-resume-complete", "parent-received-reply", "parent-request-write"].sort());
    assert.deepEqual(result.completedClis, ["child", "parent"]);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.unexpectedRequests, 0);
  });
}

}
