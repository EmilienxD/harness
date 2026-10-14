import { test } from "node:test";
import { runPiCommit, runPiCommitAi, runPiCommitLifecycle } from "../tools/pi-commit/run.js";
for (const scope of ["project", "user"] as const) for (const mode of ["json", "rpc"] as const) test(`Pi commit ${scope} ${mode}: verified native/shell writes and isolated index`, { timeout: 150_000 }, async () => { await runPiCommit(scope, mode); });
test("Pi commit native nested calls, reload/resume/tree and conservative attribution", { timeout: 240_000 }, async () => { await runPiCommitLifecycle(); });
test("Pi commit direct AI generation and failed-generation index preservation", { timeout: 150_000 }, async () => { await runPiCommitAi(); });
