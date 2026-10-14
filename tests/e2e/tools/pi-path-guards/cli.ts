import { runPiGuardResumeJourney, runPiGuardStateJourney, runPiPartialReadJourney, runPiPathGuardJourney, runPiShellReadJourney } from "./run.js";

async function main() {
  for (const mode of ["json", "rpc"] as const) {
    for (const scope of ["project", "user"] as const) {
      for (const packageName of ["on-read-reminder", "on-edit-reminder", "on-edit-block"] as const) {
        console.log(JSON.stringify(await runPiPathGuardJourney(packageName, mode, scope)));
      }
    }
    await runPiPartialReadJourney(mode);
  }
  await runPiGuardStateJourney();
  await runPiShellReadJourney();
  await runPiGuardResumeJourney();
  console.log(JSON.stringify({ status: "success", journeys: 17, upstreamMode: "forbidden" }));
}

main().catch(() => { console.error("Pi path guard journey failed; run test:pi-path-guards for structural diagnostics."); process.exitCode = 1; });
