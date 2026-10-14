import test from "node:test";
import { runPiNotificationFailureJourney, runPiNotificationJourney } from "../tools/pi-desktop-notification/run.js";

for (const scope of ["project", "user"] as const)
  test(`real Pi ${scope} notifications persist, settle once, isolate new/fork sessions and remove`, { timeout: 180_000 }, async () => { await runPiNotificationJourney(scope); });

test("real Pi notifies final provider failure and abort once", { timeout: 90_000 }, async () => { await runPiNotificationFailureJourney(); });
