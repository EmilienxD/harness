import test from "node:test";
import { runReportGotchasJourney } from "../tools/report-gotchas/run.js";

for (const platform of ["claude", "chatgpt"] as const) {
  test(`real ${platform} posts through bundled report scripts to local HTTPS with package managers offline`, { timeout: 180_000 }, async () => {
    await runReportGotchasJourney(platform, false);
  });
}
