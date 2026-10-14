import { runPiCommandGuardJourney, runPiMalformedPolicyJourney } from "./run.js";

async function main() {
  for (const mode of ["json", "rpc"] as const) {
    for (const scope of ["project", "user"] as const) {
      console.log(JSON.stringify(await runPiCommandGuardJourney(mode, scope)));
    }
    await runPiMalformedPolicyJourney(mode);
  }
  console.log(JSON.stringify({ status: "success", journeys: 6, upstreamMode: "forbidden" }));
}

main().catch(() => { console.error("Pi command-guard journey failed; run test:pi-command-guard for structural diagnostics."); process.exitCode = 1; });
