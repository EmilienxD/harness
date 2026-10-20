import assert from "node:assert/strict";
import test from "node:test";

import { runActivity, type ActivityEntry } from "../../src/domain/activity.js";
import type { AgentId, IsoTimestamp, TerminalId } from "../../src/domain/contracts.js";
import { ActivityTreeModel } from "../../src/vscode/activity.js";

function rowFor(entry: ActivityEntry) {
  const model = new ActivityTreeModel({ entries: () => [entry], isTerminalOpen: () => false });
  return model.item(model.roots()[0]!);
}

test("an agent row without title metadata does not expose its routing identifier as a name", () => {
  const row = rowFor({
    kind: "agent", id: "agent:10:ended", at: "2026-09-09T10:00:00.000Z" as IsoTimestamp,
    agentId: "10" as AgentId, type: "interactive", description: "aboard-interactive-10",
    outcome: "ended", durationMs: 10_000,
  });

  assert.equal(row.label, "New session");
  assert.equal(row.description, "ended · 10s");
});

test("an activity row shows the conversation title without repeating its routing identifier", () => {
  const row = rowFor({
    kind: "agent", id: "agent:10:ended", at: "2026-09-09T10:00:00.000Z" as IsoTimestamp,
    agentId: "10" as AgentId, type: "interactive", description: "aboard-interactive-10",
    title: "Fix checkout recovery", outcome: "ended",
  });
  assert.equal(row.label, "Fix checkout recovery");
  assert.equal(row.description, "ended");
});

test("an agent row keeps a description that differs from the agent's name", () => {
  const row = rowFor({
    kind: "agent", id: "agent:3:failed", at: "2026-09-09T10:00:00.000Z" as IsoTimestamp,
    agentId: "3" as AgentId, type: "address", description: "address issue 34",
    outcome: "failed", issueNumbers: [34],
  });

  assert.equal(row.label, "New session");
  assert.match(row.description, /^failed · address issue 34 · /u);
});

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
