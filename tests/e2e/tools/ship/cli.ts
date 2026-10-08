import { runShipJourney, type ShipPlatform } from "./run.js";
import { SCENARIOS, type ShipScenario } from "./scenario.js";

// Usage: cli.js [claude|chatgpt|all] [scenario|all]. Journeys share one GitHub
// fixture and must therefore run sequentially.
const [platformArg = "all", scenarioArg = "all"] = process.argv.slice(2);
const platforms: ShipPlatform[] = platformArg === "all" ? ["claude", "chatgpt"] : [platformArg as ShipPlatform];
const scenarios: ShipScenario[] = scenarioArg === "all" ? [...SCENARIOS] : [scenarioArg as ShipScenario];
if (!platforms.every((item) => item === "claude" || item === "chatgpt") || !scenarios.every((item) => SCENARIOS.includes(item))) {
  process.stderr.write(`Usage: cli.js [claude|chatgpt|all] [${SCENARIOS.join("|")}|all]\n`);
  process.exit(2);
}
void (async () => {
  for (const platform of platforms) {
    for (const scenario of scenarios) {
      try {
        process.stdout.write(`${JSON.stringify(await runShipJourney(platform, scenario))}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : "Ship journey failed"}\n`);
        process.exitCode = 1;
      }
    }
  }
})();
