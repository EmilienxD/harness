import assert from "node:assert/strict";
import test from "node:test";
import { runChromeDevtoolsJourney } from "../tools/chrome-devtools/run.js";

for (const scope of ["project", "user"] as const) {
  test(`Chrome DevTools installs and automates a browser through real Pi at ${scope} scope`, { timeout: 240_000 }, async () => {
    const result = await runChromeDevtoolsJourney(scope);
    assert.equal(result.requests, 3);
  });
}
