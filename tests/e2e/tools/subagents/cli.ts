import { runSubagentsJourney, runSubagentsRecoveryJourney, runSubagentsRootJourney } from "./run.js";

async function main(): Promise<void> {
  const selected = process.argv.slice(2).find((arg) => arg !== "--skills");
  if (selected !== undefined && selected !== "claude" && selected !== "chatgpt") {
    throw new Error("usage: subagents E2E [claude|chatgpt] [--skills]");
  }
  const platforms = selected === undefined ? ["claude", "chatgpt"] as const : [selected] as const;
  for (const platform of platforms) {
    if (process.argv.includes("--skills")) {
      for (const skill of ["none", "found", "missing"] as const) {
        const result = await runSubagentsJourney(platform, "auto", false, false, { skill });
        process.stdout.write(`subagents ${platform} ${skill} E2E passed (${result.checkpoints.join(" -> ")})\n`);
      }
      continue;
    }
    const rooted = await runSubagentsRootJourney(platform);
    process.stdout.write(`subagents ${platform} root E2E passed (${rooted.checkpoints.join(" -> ")})\n`);
    const recovery = await runSubagentsRecoveryJourney(platform);
    process.stdout.write(`subagents ${platform} recovery E2E passed (${recovery.checkpoints.join(" -> ")})\n`);
    for (const mode of ["interactive","auto"] as const) {
      const result = await runSubagentsJourney(platform,mode);
      process.stdout.write(`subagents ${platform} ${mode} E2E passed (${result.checkpoints.join(" -> ")})\n`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
