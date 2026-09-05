import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runTests } from "@vscode/test-electron";
import { loadConfig } from "../config.js";
import { resetLocal } from "../repository.js";
import { startFakeAnthropicServer } from "../server.js";
import { childEnvironment, validateClaudeCli } from "../smoke.js";
import { MANAGER_SCENARIO_MARKER } from "../scenario.js";
import { prepareInteractiveClaudeConfig, testExecutable } from "./support.js";

export async function runExtensionJourney(): Promise<void> {
  const config = loadConfig();
  await validateClaudeCli();
  await resetLocal(config);
  await mkdir(config.claudeConfigRoot, { recursive: true });
  await prepareInteractiveClaudeConfig(config.claudeConfigRoot, [config.cloneRoot, resolve(__dirname, "..", "..", "..")]);
  const server = await startFakeAnthropicServer({ repoRoot: config.cloneRoot, diagnosticsPath: config.diagnosticsPath, readinessPath: config.readinessPath });
  try {
    const environment = childEnvironment(process.env, {
      ANTHROPIC_BASE_URL: server.baseUrl,
      ANTHROPIC_AUTH_TOKEN: server.authToken,
      CLAUDE_CONFIG_DIR: config.claudeConfigRoot,
      CLAUDE_CODE_PROJECT_DIR_NAME: "aboard-e2e",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
      ABOARD_E2E_DIAGNOSTICS: config.diagnosticsPath,
      ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot,
    });
    const executable = await testExecutable();
    for (const phase of ["initialize", "delegation"]) {
      if (phase === "delegation") {
        const managerPath = join(config.cloneRoot, ".abd", "agents", "manager.md");
        const manager = await readFile(managerPath, "utf8");
        const command = `command: claude "${MANAGER_SCENARIO_MARKER} delegate the deterministic inspection"`;
        if (!/^command: claude$/mu.test(manager)) throw new Error("Manager definition does not expose the canonical Claude command");
        await writeFile(managerPath, manager.replace(/^command: claude$/mu, command), "utf8");
      }
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: resolve(__dirname, "..", "..", ".."),
        extensionTestsPath: resolve(__dirname, "suite.js"),
        extensionTestsEnv: { ...environment, ABOARD_E2E_PHASE: phase },
        launchArgs: [config.cloneRoot, "--disable-extensions"],
      });
    }
    const assertions = server.assertions();
    for (const checkpoint of ["delegate-explore", "explore-read", "explore-complete", "manager-complete"]) {
      if (!assertions.checkpoints.includes(checkpoint)) throw new Error(`Extension journey did not reach ${checkpoint}`);
    }
    if (assertions.inferenceRequests !== 4 || assertions.unexpectedRequests !== 0) {
      throw new Error(`Unexpected extension inference activity: ${assertions.inferenceRequests} inference requests, ${assertions.unexpectedRequests} rejected requests`);
    }
  } finally {
    await server.close();
    await resetLocal(config);
  }
}

void runExtensionJourney().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Extension E2E journey failed"}\n`);
  process.exitCode = 1;
});
