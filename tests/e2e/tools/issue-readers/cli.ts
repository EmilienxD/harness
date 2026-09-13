import { runIssueReadersJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runIssueReadersJourney(platform);
    process.stdout.write(`issue-readers ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
