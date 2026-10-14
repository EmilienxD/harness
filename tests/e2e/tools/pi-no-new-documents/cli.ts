import { runPiDocumentsJourney, runPiDocumentsPathsJourney, runPiDocumentsSafetyJourney } from "./run.js";

async function main() {
  for (const mode of ["json", "rpc"] as const) for (const scope of ["project", "user"] as const) {
    console.log(JSON.stringify(await runPiDocumentsJourney(mode, scope)));
  }
  await runPiDocumentsSafetyJourney();
  for (const scope of ["project", "user"] as const) console.log(JSON.stringify(await runPiDocumentsPathsJourney(scope)));
}
main().catch(() => { console.error("Pi document draft journey failed."); process.exitCode = 1; });
