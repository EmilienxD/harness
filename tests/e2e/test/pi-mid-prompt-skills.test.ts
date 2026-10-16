import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiFixture } from "../core/pi-fixture.js";
import { routeInvocations } from "../tools/pi-mid-prompt-skills/scenario.js";
import { runPiMidPromptSkills } from "../tools/pi-mid-prompt-skills/run.js";

for (const scope of ["project", "user"] as const) {
  test(`Pi mid-prompt-skills ${scope}: native expansion, exclusions, images and removal`, { timeout: 240_000 }, async () => {
    await runPiMidPromptSkills(scope, scope === "project" ? "json" : "rpc");
  });
}

test("Pi mid-prompt skill routing rejects unknown histories without fallback", { timeout: 30_000 }, async () => {
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-mid-prompt-unknown-v1", transition: (request) => routeInvocations(new Map(), request) });
  try {
    const run = await fixture.runJson({ prompt: "[E2E:unknown-mid-prompt-case]" });
    assert.equal(run.status, "failed");
    assert.deepEqual(run.toolExecutions, []);
    assert.equal(fixture.assertions().inferenceRequests, 1);
    assert.equal(fixture.assertions().unexpectedRequests, 1);
  } finally { await fixture.close(); }
});
