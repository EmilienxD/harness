import test from "node:test";
import { runPiSlashCommandGuardJourney } from "../tools/pi-slash-command-guard/run.js";

for (const scope of ["project", "user"] as const) {
  test(`real Pi ${scope} rejects unknown slash commands without inference and preserves known commands`,
    { timeout: 90_000 }, async () => { await runPiSlashCommandGuardJourney(scope); });
}
