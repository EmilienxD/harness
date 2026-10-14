import assert from "node:assert/strict";
import test from "node:test";
import { runPiSharedSkillsJourney } from "../tools/pi-shared-skills/run.js";
import { createPiFixture } from "../core/pi-fixture.js";
import { routeSharedSkills } from "../tools/pi-shared-skills/scenario.js";

for (const scope of ["project", "user"] as const) {
  test(`real Pi discovers and invokes all shared skill ports at ${scope} scope`, { timeout: 240_000 }, async () => {
    const result = await runPiSharedSkillsJourney(scope);
    assert.equal(result.packages, 22);
    assert.equal(result.skills, 23);
    assert.equal(result.referenceReads, 5);
    assert.equal(result.inferenceRequests, 51);
    assert.equal(result.unexpectedRequests, 0);
  });
}

test("shared skill routing rejects an unknown real Pi history without fallback", { timeout: 90_000 }, async () => {
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-shared-rejection-v1", transition: (request) => routeSharedSkills(new Map(), request) });
  try {
    assert.equal((await fixture.runJson({ prompt: "[E2E:unknown-shared-skill]" })).status, "failed");
    assert.equal(fixture.assertions().inferenceRequests, 1);
    assert.equal(fixture.assertions().unexpectedRequests, 1);
  } finally { await fixture.close(); }
});
