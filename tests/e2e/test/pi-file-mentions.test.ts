import test from "node:test";
import { runPiFileMentionsJourney } from "../tools/pi-file-mentions/run.js";

for (const scope of ["project", "user"] as const) {
  test(`real Pi ${scope} auto-loads file mentions and bounded directory listings`, { timeout: 120_000 }, async () => {
    await runPiFileMentionsJourney(scope);
  });
}
