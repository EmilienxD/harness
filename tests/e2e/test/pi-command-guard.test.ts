import test from "node:test";
import { runPiCommandGuardJourney, runPiMalformedPolicyJourney } from "../tools/pi-command-guard/run.js";

for (const mode of ["json", "rpc"] as const) {
  for (const scope of ["project", "user"] as const) {
    test(`real Pi ${mode} ${scope} command-guard installs, allows safe and denies configured commands, then removes coupled support`, { timeout: 90_000 }, async () => {
      await runPiCommandGuardJourney(mode, scope);
    });
  }
  test(`real Pi ${mode} command-guard denies every command when the policy is malformed`, { timeout: 90_000 }, async () => {
    await runPiMalformedPolicyJourney(mode);
  });
}
