import { runPiSharedSkillsJourney } from "./run.js";

async function main() {
  for (const scope of ["project", "user"] as const) console.log(JSON.stringify(await runPiSharedSkillsJourney(scope)));
}
void main().catch(() => { console.error("Pi shared-skills journey failed; inspect structural diagnostics and focused test assertions"); process.exitCode = 1; });
