import assert from "node:assert/strict";
import test from "node:test";

import { runActivity } from "../src/domain/activity.js";
import type { IsoTimestamp, TerminalId } from "../src/domain/contracts.js";
import { ActivityTreeModel } from "../src/vscode/activity.js";

test("an auto-run start is shown as a successful activity", () => {
  const entry = runActivity({
    runId: "run_1",
    attempt: 1,
    outcome: "started",
    at: "2026-09-09T10:00:00.000Z" as IsoTimestamp,
  });
  const model = new ActivityTreeModel({
    entries: () => [entry],
    isTerminalOpen: (_terminalId: TerminalId) => false,
  });

  assert.equal(model.item(model.roots()[0]!).icon, "pass");
});
