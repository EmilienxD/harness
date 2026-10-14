import { runFlushOutUselessTestsJourney } from "./run.js";

async function main(): Promise<void> {
  for (const [scope, mode] of [["project", "json"], ["project", "rpc"], ["user", "rpc"]] as const) {
    const result = await runFlushOutUselessTestsJourney(scope, mode);
    if (!result.removed || !result.chatgptPreserved || !result.settingsPreserved || !result.unchangedBeforeApproval || !result.noReportFile || result.inferenceRequests !== 7 || result.unexpectedRequests !== 0 || result.baselineCounts !== 2) throw new Error("flush-out-useless-tests failed its installer/skill effect contract");
    process.stdout.write(`flush-out-useless-tests Pi ${scope}/${mode} passed: ${result.checkpoints.join(" -> ")}\n`);
  }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Pi flush journey failed"}\n`); process.exitCode = 1; });
