import { runOnEditBlockJourney } from "./run.js";

runOnEditBlockJourney().then((result) => {
  process.stdout.write(`on-edit-block E2E passed (${result.checkpoints.join(" -> ")})\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
