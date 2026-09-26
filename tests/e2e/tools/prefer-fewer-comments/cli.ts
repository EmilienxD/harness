import { runPreferFewerCommentsJourney } from "./run.js";

async function main(): Promise<void> {
  for (const [platform, method] of [["claude", "native"], ["claude", "shell"], ["claude", "printf"], ["chatgpt", "shell"]] as const) {
    const result = await runPreferFewerCommentsJourney(platform, method);
    if (result.unexpectedRequests !== 0) throw new Error(`${platform} ${method}: unexpected fake API requests`);
    process.stdout.write(`PASS prefer-fewer-comments ${platform} ${method}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
