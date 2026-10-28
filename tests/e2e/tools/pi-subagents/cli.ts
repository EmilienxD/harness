import assert from "node:assert/strict";
import { runPiSubagentsJourney } from "./run.js";

async function main() {
  const origin = process.env.HARNESS_GRILL_URL;
  const code = process.env.HARNESS_GRILL_CODE;
  if (!origin || !code) throw new Error("Combined live acceptance requires HARNESS_GRILL_URL and HARNESS_GRILL_CODE for a local board");
  for (const route of ["auto", "interactive"] as const) {
    const result = await runPiSubagentsJourney(route, {
      pinnedRuntimes: true, fullStack: true, explicitModel: true, localBoard: { origin, code },
    });
    assert.equal(result.parentStatus, "success");
    assert.equal(result.request.state, "succeeded");
    assert.equal(result.request.provider, "pi");
    assert.equal(result.request.mode, route);
    assert.equal(result.request.boundToNativeSession, true);
    assert.equal(result.request.acknowledged, true);
    assert.equal(result.deliveryMatchesRequest, true);
    assert.equal(result.deliveredResults, 1);
    assert.equal(result.publishedRounds, 1);
    assert.equal(result.childModel, "gpt-6.1-sol");
    assert.equal(result.childThinkingLevel, "medium");
    assert.equal(result.childSessionSaved, true);
    assert.equal(result.requestFilesRemaining, 0);
    assert.equal(result.inferenceRequests, 6);
    assert.equal(result.unexpectedRequests, 0);
    if (route === "interactive") assert.equal(result.previousReplyInferenceRequests, 0);
    console.log(JSON.stringify({ route, parentStatus: result.parentStatus, publishedRounds: result.publishedRounds, childModel: result.childModel, childThinkingLevel: result.childThinkingLevel, inferenceRequests: result.inferenceRequests, unexpectedRequests: result.unexpectedRequests, upstreamMode: "forbidden", hosted: new URL(origin).hostname }));
  }
}

main().catch(() => { console.error("Combined Pi cloud/subagent acceptance failed; run the focused tests for structural diagnostics."); process.exitCode = 1; });
