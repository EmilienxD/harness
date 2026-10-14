import { runPiCommentsJourney, runPiCommentsRecoveryJourney, runPiCommentsStateJourney } from "./run.js";

async function main() {
  for (const scope of ["project", "user"] as const) {
    console.log(JSON.stringify(await runPiCommentsJourney(scope === "project" ? "json" : "rpc", scope)));
  }
  await runPiCommentsStateJourney();
  await runPiCommentsRecoveryJourney();
  console.log("Pi comment lifecycle journey passed.");
}
main().catch(() => { console.error("Pi comment journey failed; run the focused real-CLI tests for structural diagnostics."); process.exitCode = 1; });
