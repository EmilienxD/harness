import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { bootstrap, reset } from "./repository.js";
import { startFakeAnthropicServer } from "./server.js";
import { runSmoke } from "./smoke.js";
import { runChatGptSmoke } from "./chatgpt.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  if (command === "bootstrap") {
    await bootstrap(config);
    process.stdout.write(`Recreated and seeded private repository ${config.repository}; runtime clone: ${config.cloneRoot}\n`);
    return;
  }
  if (command === "reset") {
    await reset(config);
    process.stdout.write(`Reset ${config.repository} and ${config.cloneRoot} to the canonical seed\n`);
    return;
  }
  if (command === "smoke") {
    await runSmoke(config);
    process.stdout.write(`Smoke passed; edited fixture retained at ${config.cloneRoot}\\deterministic.txt\n`);
    return;
  }
  if (command === "chatgpt") {
    await runChatGptSmoke(config);
    process.stdout.write("Deterministic ChatGPT launch, completion, and process-failure scenarios passed\n");
    return;
  }
  if (command === "serve") {
    await mkdir(config.runtimeRoot, { recursive: true });
    const server = await startFakeAnthropicServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath });
    process.stdout.write(`${JSON.stringify({ baseUrl: server.baseUrl, authToken: server.authToken, readinessPath: config.readinessPath })}\n`);
    await waitForSignal();
    await server.close();
    return;
  }
  throw new Error("Usage: e2e/cli.ts <bootstrap|reset|serve|smoke|chatgpt>");
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
