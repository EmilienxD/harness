import { runSubagentsJourney } from "./run.js";

async function main(): Promise<void> {
  const selected = process.argv[2];
  if (selected !== undefined && selected !== "claude" && selected !== "chatgpt") {
    throw new Error("usage: subagents E2E [claude|chatgpt]");
  }
  const platforms = selected === undefined ? ["claude", "chatgpt"] as const : [selected] as const;
  for (const platform of platforms) {
    const result = await runSubagentsJourney(platform);
    process.stdout.write(`subagents ${platform} E2E passed (${result.checkpoints.join(" -> ")})\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
