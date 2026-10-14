import { runPiGotchasJourney } from "./run.js";
async function main() {
  for (const [scope, mode] of [["project", "json"], ["user", "rpc"]] as const)
    process.stdout.write(JSON.stringify(await runPiGotchasJourney(scope, mode)) + "\n");
}
void main().catch(() => { process.stderr.write("Pi report-gotchas journey failed.\n"); process.exitCode = 1; });
