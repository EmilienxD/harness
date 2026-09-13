import { runPreferEditToolJourney } from "./run.js";

void runPreferEditToolJourney()
  .then((result) => process.stdout.write(`prefer-edit-tool E2E passed (${result.checkpoints.join(" -> ")})\n`))
  .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
