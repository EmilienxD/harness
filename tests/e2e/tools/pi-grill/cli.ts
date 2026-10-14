import { runPiGrill, runPiGrillAdmission } from "./run.js";

async function main() {
  const live = process.argv.includes("--live");
  const admission = process.argv.includes("--admission");
  const origin = process.env.HARNESS_GRILL_URL;
  const code = process.env.HARNESS_GRILL_CODE;
  if ((live || admission) && (!origin || !code)) throw new Error("Live Grill E2E requires HARNESS_GRILL_URL and HARNESS_GRILL_CODE");
  if (admission) { console.log(JSON.stringify(await runPiGrillAdmission(origin!, code!))); return; }
  for (const scope of ["project", "user"] as const) {
    console.log(JSON.stringify(await runPiGrill({ scope, mode: scope === "project" ? "rpc" : "json", faults: !live, ...(live ? { origin: origin!, code: code! } : {}) })));
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "Pi grill E2E failed"); process.exitCode = 1; });
