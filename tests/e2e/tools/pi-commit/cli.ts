import { runPiCommit, runPiCommitAi, runPiCommitLifecycle } from "./run.js";
async function main() {
  for (const scope of ["project", "user"] as const) for (const mode of ["json", "rpc"] as const) console.log(JSON.stringify(await runPiCommit(scope, mode)));
  console.log(JSON.stringify(await runPiCommitLifecycle()));
  console.log(JSON.stringify(await runPiCommitAi()));
}
main().catch(() => { console.error("Pi commit journey failed"); process.exitCode = 1; });
