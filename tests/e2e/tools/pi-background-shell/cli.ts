import { runPiBackgroundShellJourney } from "./run.js";

async function main() {
  for (const [scope, shell] of [["project", "bash"], ["user", process.platform === "win32" ? "powershell" : "bash"]] as const) {
    const result = await runPiBackgroundShellJourney(scope, shell);
    process.stdout.write(`Pi ${result.version} background-shell ${scope}/${shell}: passed (${result.requests} local inference requests)\n`);
  }
}
main().catch(() => { process.stderr.write("Pi background-shell journey failed; inspect structural diagnostics.\n"); process.exitCode = 1; });
