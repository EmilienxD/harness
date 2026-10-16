import { runPiMidPromptSkills } from "./run.js";

async function main() {
  for (const scope of ["project", "user"] as const) {
    console.log(JSON.stringify(await runPiMidPromptSkills(scope, scope === "project" ? "json" : "rpc")));
  }
}
main().catch(() => {
  console.error("Pi mid-prompt-skills journey failed; run the focused test for structural diagnostics.");
  process.exitCode = 1;
});
