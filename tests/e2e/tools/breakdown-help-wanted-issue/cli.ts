import { runBreakdownHelpWantedIssueJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runBreakdownHelpWantedIssueJourney(platform);
    process.stdout.write(`breakdown-help-wanted-issue ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
