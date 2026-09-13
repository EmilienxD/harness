import { runOnEditReminderJourney } from "./run.js";

void runOnEditReminderJourney()
  .then((result) => process.stdout.write(`on-edit-reminder E2E passed (${result.checkpoints.join(" -> ")})\n`))
  .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
