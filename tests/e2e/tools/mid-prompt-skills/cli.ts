import { runMidPromptSkillsJourney } from "./run.js";

void runMidPromptSkillsJourney()
  .then((result) => process.stdout.write(`mid-prompt-skills E2E passed (${result.checkpoints.join(" -> ")})\n`))
  .catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
