import { runNoNewDocumentsJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runNoNewDocumentsJourney(platform);
    process.stdout.write(`no-new-documents ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
