import test from "node:test";
import { runPiCommentsJourney, runPiCommentsRecoveryJourney, runPiCommentsStateJourney } from "../tools/pi-prefer-fewer-comments/run.js";

for (const mode of ["json", "rpc"] as const) {
  for (const scope of ["project", "user"] as const) {
    test(`real Pi ${mode} ${scope} comment budgets use successful native additions`, { timeout: 90_000 }, async () => {
      await runPiCommentsJourney(mode, scope);
    });
  }
}
test("real Pi comment receipts survive reload/resume and follow active ancestry; nested writes retain other guards", { timeout: 90_000 }, runPiCommentsStateJourney);
test("real Pi helper outage preserves success and cooldown; zero budgets and new sessions work", { timeout: 90_000 }, runPiCommentsRecoveryJourney);
