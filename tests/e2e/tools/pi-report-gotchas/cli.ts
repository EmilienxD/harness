import { runPiGotchasJourney } from "./run.js";
async function main() {
  const live = process.argv.includes("--live");
  const journeys = live ? [["project", "json"]] as const : [["project", "json"], ["user", "rpc"]] as const;
  for (const [scope, mode] of journeys)
    process.stdout.write(JSON.stringify(await runPiGotchasJourney(scope, mode, live)) + "\n");
}
void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Pi report-gotchas journey failed"}\n`); process.exitCode = 1; });
