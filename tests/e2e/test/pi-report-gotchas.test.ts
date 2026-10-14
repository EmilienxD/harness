import test from "node:test";
import { runPiGotchasJourney } from "../tools/pi-report-gotchas/run.js";
for (const scope of ["project", "user"] as const)
  for (const mode of ["json", "rpc"] as const)
    test(`real Pi ${scope} ${mode} gotchas bind identity, deduplicate, recover delivery and remove`, { timeout: 180_000 }, async () => {
      await runPiGotchasJourney(scope, mode);
    });
