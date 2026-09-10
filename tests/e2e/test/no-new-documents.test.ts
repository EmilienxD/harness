import assert from "node:assert/strict";
import test from "node:test";

import { runNoNewDocumentsJourney } from "../tools/no-new-documents/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`no-new-documents blocks creation and makes the real ${platform} CLI report the proposal`, async () => {
    const result = await runNoNewDocumentsJourney(platform);
    assert.deepEqual(result.checkpoints, ["create-denied", "complete"]);
    assert.equal(result.documentExists, false);
    assert.match(result.finalText, /nested\/docs\/proposal\.md/u);
    assert.match(result.finalText, /why|because|wanted/iu);
    assert.equal(result.unexpectedRequests, 0);
  });
}
