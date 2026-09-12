import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceAgentIdCounter } from "../../src/runtime/agent-id-counter.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "aboard-agent-id-"));
}

test("agent ids are strictly monotonic and never repeated", () => {
  const counter = WorkspaceAgentIdCounter.load(tempRoot());
  assert.equal(counter.next(), "1");
  assert.equal(counter.next(), "2");
  assert.equal(counter.next(), "3");
});

test("agent ids pass the launch filename-safety contract", () => {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // mirrors AGENT_ID_PATTERN in launch.ts
  const counter = WorkspaceAgentIdCounter.load(tempRoot());
  for (let index = 0; index < 25; index += 1) assert.match(counter.next(), pattern);
});

test("a fresh activation resumes past the persisted counter, so ids are never reused across restarts", () => {
  const root = tempRoot();
  const first = WorkspaceAgentIdCounter.load(root);
  first.next();
  first.next();
  const second = WorkspaceAgentIdCounter.load(root);
  assert.equal(second.next(), "3");
});

test("upgrade seeds from the fleet's numeric ceiling instead of restarting at 1", () => {
  const counter = WorkspaceAgentIdCounter.load(tempRoot(), () => ["1", "2", "3"]);
  assert.equal(counter.next(), "4");
});

test("pre-numeric UUID fleet ids contribute nothing to the ceiling", () => {
  const counter = WorkspaceAgentIdCounter.load(tempRoot(), () => ["3f9a2b1c-8d4e-4000-8000-000000000001", "not-a-number"]);
  assert.equal(counter.next(), "1");
});

test("a corrupt counter file bootstraps from the fleet ceiling rather than failing activation", () => {
  const root = tempRoot();
  writeFileSync(join(root, "agent-counter.json"), "truncated", "utf8");
  const counter = WorkspaceAgentIdCounter.load(root, () => ["7"]);
  assert.equal(counter.next(), "8");
});

test("the fleet ceiling wins over a stale counter lower than live numeric ids", () => {
  const root = tempRoot();
  const first = WorkspaceAgentIdCounter.load(root);
  first.next(); // persists value: 1
  // An earlier activation of the same workspace got further (ids 1..5) before
  // its counter file was lost; reseeding must not reuse 2..5.
  const reseeded = WorkspaceAgentIdCounter.load(root, () => ["5"]);
  assert.equal(reseeded.next(), "6");
});

test("the supplied persisted identity contributes to the ceiling", () => {
  const counter = WorkspaceAgentIdCounter.load(tempRoot(), () => ["2"]);
  assert.equal(counter.next(), "3");
});
