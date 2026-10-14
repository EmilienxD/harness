import { runLivePiIssues } from "./live.js";

async function main() {
  for (const scope of ["project", "user"] as const) console.log(JSON.stringify(await runLivePiIssues(scope)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Live Pi issue journey failed");
  process.exitCode = 1;
});
