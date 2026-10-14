import test from "node:test";
import { runPiDocumentsJourney, runPiDocumentsSafetyJourney } from "../tools/pi-no-new-documents/run.js";

for (const mode of ["json", "rpc"] as const) for (const scope of ["project", "user"] as const) {
  test(`real Pi ${mode} ${scope} guards documents, commands approve without inference, reload/tree preserve notices`, { timeout: 120_000 }, async () => {
    await runPiDocumentsJourney(mode, scope);
  });
}

test("real Pi rejects malformed policy and escaping paths; competing approval commands publish once", { timeout: 90_000 }, runPiDocumentsSafetyJourney);
