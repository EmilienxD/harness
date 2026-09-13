import { runCommitJourney } from "./run.js";
runCommitJourney().then(() => process.stdout.write("commit E2E passed\n"), (error) => { process.stderr.write(String(error)); process.exitCode = 1; });
