import { runPreferFewerCommentsJourney } from "./run.js";

void (async () => {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runPreferFewerCommentsJourney(platform);
    process.stdout.write(`prefer-fewer-comments ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
})().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
