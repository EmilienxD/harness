import test from "node:test";
import { runPiBackgroundShellJourney } from "../tools/pi-background-shell/run.js";

test("real Pi project Bash background completion, failure, timeout, logs and guard denial", { timeout: 150000 }, async () => {
  await runPiBackgroundShellJourney("project", "bash");
});
test("real Pi user PowerShell background completion and installer ownership", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  await runPiBackgroundShellJourney("user", "powershell");
});
