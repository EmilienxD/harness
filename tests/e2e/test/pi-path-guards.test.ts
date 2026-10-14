import test from "node:test";
import { runPiGuardResumeJourney, runPiGuardStateJourney, runPiPartialReadJourney, runPiPathGuardJourney, runPiShellReadJourney } from "../tools/pi-path-guards/run.js";

test("real Pi nested reads authorize writes only on the active branch; reload preserves receipts", { timeout: 90_000 }, runPiGuardStateJourney);
test("real Pi shell reads trigger reminders; only complete observed shell reads authorize writes", { timeout: 90_000 }, runPiShellReadJourney);
test("real Pi exact-session resume recovers successful guidance reads before allowing a write", { timeout: 90_000 }, runPiGuardResumeJourney);

for (const mode of ["json", "rpc"] as const) {
  for (const scope of ["project", "user"] as const) {
    for (const packageName of ["on-read-reminder", "on-edit-reminder", "on-edit-block"] as const) {
      test(`real Pi ${mode} ${scope} ${packageName} installs, enforces policy and removes coupled support`, { timeout: 90_000 }, async () => {
        await runPiPathGuardJourney(packageName, mode, scope);
      });
    }
  }
  test(`real Pi ${mode} failed and partial reads do not authorize edits; complete range coverage does`, { timeout: 90_000 }, async () => {
    await runPiPartialReadJourney(mode);
  });
}
