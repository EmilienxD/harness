import { runRedirectSubagentsJourney } from "./run.js";

runRedirectSubagentsJourney().then((result) => {
  process.stdout.write(`redirect-subagents E2E passed (${result.checkpoints.join(" -> ")})\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
