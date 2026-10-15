import test from "node:test";
import { runPiWebToolkitJourney } from "../tools/pi-web-toolkit/run.js";
for (const [scope, mode] of [["project", "json"], ["user", "rpc"]] as const)
  test(`real Pi ${scope}/${mode} Web Toolkit search, fetch, errors, cancellation and removal`, { timeout: 180_000 }, async () => {
    await runPiWebToolkitJourney(scope, mode);
  });
