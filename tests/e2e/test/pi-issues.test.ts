import { test } from "node:test";
import { runPiIssueReaders, runPiIssueWriters } from "../tools/pi-issues/run.js";

for (const scope of ["project", "user"] as const) {
  test(`Pi issue readers ${scope}: prepare, implement, review and stop dirty addressing`, { timeout: 120_000 }, async () => {
    await runPiIssueReaders(scope, scope === "project" ? "json" : "rpc");
  });
  test(`Pi issue writers ${scope}: native drafting skills and zero-inference publication`, { timeout: 120_000 }, async () => {
    await runPiIssueWriters(scope);
  });
}
