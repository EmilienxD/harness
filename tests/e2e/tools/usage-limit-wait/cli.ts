import { runUsageLimitWaitJourney } from "./run.js";

async function main(): Promise<void> {
  for (const platform of ["claude", "chatgpt"] as const) {
    const result = await runUsageLimitWaitJourney(platform);
    process.stdout.write(`${platform}: ${JSON.stringify({ checkpoints: result.checkpoints, usageRequests: result.usageRequests, unexpectedRequests: result.unexpectedRequests })}\n`);
  }
}

void main();
