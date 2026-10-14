import { test } from "node:test";
import { runPiCleanupGit } from "../tools/pi-cleanup-git/run.js";

for (const scope of ["project", "user"] as const) {
  test(`Pi cleanup-git ${scope}: read-only inventory, named approval and live-state preservation`, { timeout: 120_000 }, async () => {
    await runPiCleanupGit(scope, scope === "project" ? "json" : "rpc");
  });
}
