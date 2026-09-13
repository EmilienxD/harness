import { runOnReadReminderJourney } from "./run.js";

void runOnReadReminderJourney()
  .then((result) => process.stdout.write(`on-read-reminder E2E passed (${result.checkpoints.join(" -> ")})\n`))
  .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
