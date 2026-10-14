import { runPiCleanupGit } from "./run.js";

async function main() {
  for (const scope of ["project", "user"] as const) {
    console.log(JSON.stringify(await runPiCleanupGit(scope, scope === "project" ? "json" : "rpc")));
  }
}
main().catch(() => { console.error("Pi cleanup-git E2E failed; inspect structural checkpoints."); process.exitCode = 1; });
