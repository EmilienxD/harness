import { resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { loadConfig } from "../config.js";
import { resetLocal } from "../repository.js";
import { testExecutable } from "./support.js";

export async function runExtensionJourney(): Promise<void> {
  const config = loadConfig();
  await resetLocal(config);
  try {
    const executable = await testExecutable();
    for (const phase of ["initialize", "admission"]) {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: resolve(__dirname, "..", "..", ".."),
        extensionTestsPath: resolve(__dirname, "suite.js"),
        extensionTestsEnv: { ...process.env, ABOARD_E2E_PHASE: phase, ABOARD_E2E_REPOSITORY_ROOT: config.cloneRoot },
        launchArgs: [config.cloneRoot, "--disable-extensions"],
      });
    }
  } finally {
    await resetLocal(config);
  }
}

void runExtensionJourney().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : "Extension E2E journey failed"}\n`);
  process.exitCode = 1;
});
