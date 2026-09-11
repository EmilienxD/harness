import { runReportGotchasJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runReportGotchasJourney(platform);
    const cliName = platform === "claude" ? "Claude Code" : "Codex";
    process.stdout.write(`report-gotchas ${cliName} live E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
