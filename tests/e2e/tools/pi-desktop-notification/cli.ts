import { runPiNativeNotificationSmoke, runPiNotificationFailureJourney, runPiNotificationJourney } from "./run.js";

async function main() {
  if (process.argv.includes("--native")) { console.log(JSON.stringify(await runPiNativeNotificationSmoke())); return; }
  for (const scope of ["project", "user"] as const) console.log(JSON.stringify(await runPiNotificationJourney(scope)));
  console.log(JSON.stringify(await runPiNotificationFailureJourney()));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Pi notification journey failed"); process.exitCode = 1; });
