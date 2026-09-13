import { runCommandGuardJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runCommandGuardJourney(platform);
    process.stdout.write(`command-guard ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
