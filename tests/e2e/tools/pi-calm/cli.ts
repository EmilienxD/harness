import { runPiCalmJourney } from "./run.js";

async function main() {
  for (const scope of ["project", "user"] as const) console.log(JSON.stringify(await runPiCalmJourney(scope)));
}
void main().catch(() => { console.error("Pi Calm journey failed"); process.exitCode = 1; });
