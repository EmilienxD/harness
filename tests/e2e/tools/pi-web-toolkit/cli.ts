import { runPiWebToolkitJourney } from "./run.js";
async function main() {
  for (const [scope, mode] of [["project", "json"], ["user", "rpc"]] as const)
    process.stdout.write(`${JSON.stringify(await runPiWebToolkitJourney(scope, mode))}\n`);
}
void main().catch(() => { process.stderr.write("Pi Web Toolkit journey failed; inspect structural assertions.\n"); process.exitCode = 1; });
