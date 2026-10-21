import test from "node:test";
import { runPiEnvironmentContextJourney } from "../tools/pi-environment-context/run.js";

for (const scope of ["project", "user"] as const) {
  test(`real Pi ${scope} installs environment context, reloads, and removes it without affecting other resources`,
    { timeout: 90_000 }, async () => { await runPiEnvironmentContextJourney(scope); });
}
