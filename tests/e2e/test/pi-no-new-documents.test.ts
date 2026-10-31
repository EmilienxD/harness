import test from "node:test";
import { runPiDocumentsJourney, runPiDocumentsPathsJourney, runPiDocumentsSafetyJourney, runPiDocumentsPolicyJourney } from "../tools/pi-no-new-documents/run.js";

for (const mode of ["json", "rpc"] as const) for (const scope of ["project", "user"] as const) {
  test(`real Pi ${mode} ${scope} guards documents, commands approve without inference, reload/tree preserve notices`, { timeout: 120_000 }, async () => {
    await runPiDocumentsJourney(mode, scope);
  });
}

test("real Pi skips malformed policy and rejects escaping paths; competing approval commands publish once", { timeout: 90_000 }, runPiDocumentsSafetyJourney);
test("real Pi JSON/RPC exclusions override user protection and invalid patterns are skipped", { timeout: 120_000 }, runPiDocumentsPolicyJourney);

for (const scope of ["project", "user"] as const) {
  test(`real Pi ${scope} guards normalized native paths and linked drafts while preserving existing edits`, { timeout: 90_000 }, async () => {
    await runPiDocumentsPathsJourney(scope);
  });
}
