import test from "node:test";
import { runPiCalmJourney } from "../tools/pi-calm/run.js";

for (const scope of ["project", "user"] as const)
  test(`real Pi ${scope} Calm toggles, preserves execution and native running display, hides renderer copies and removes`,
    { timeout: 90_000 }, async () => { await runPiCalmJourney(scope); });
