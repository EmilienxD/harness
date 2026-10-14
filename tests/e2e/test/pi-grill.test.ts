import test from "node:test";
import { runPiGrill } from "../tools/pi-grill/run.js";

test("Pi cloud grill publishes assets, confirms answers and recovers unacknowledged delivery", { timeout: 150_000 }, async () => {
  await runPiGrill({ scope: "project", faults: true });
});
test("Pi cloud grill supports user installation and JSON-to-RPC resume", { timeout: 150_000 }, async () => {
  await runPiGrill({ scope: "user", mode: "json", faults: true });
});
