import { runPiSmokeJourney } from "./run.js";

async function main(): Promise<void> {
  for (const mode of ["json", "rpc"] as const) {
    const result = await runPiSmokeJourney(mode);
    if (result.status !== "success" || result.bytes !== "after\n" || result.blockedFileExists || result.inferenceRequests !== 5 || result.unexpectedRequests !== 0) throw new Error(`Pi ${mode} smoke failed its effect/request contract`);
    process.stdout.write(`Pi ${result.version} ${mode} E2E passed: ${result.checkpoints.join(" -> ")} (${result.inferenceRequests} local inference requests)\n`);
  }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Pi smoke failed"}\n`); process.exitCode = 1; });
