import assert from "node:assert/strict";
import test from "node:test";
import { renderReopenItems, reopenItemsForQuery } from "../../src/vscode/reopen.js";
import type { ReopenOption } from "../../src/platform/reopen.js";
import type { AgentId, SessionId, IsoTimestamp } from "../../src/domain/contracts.js";

function option(origin: "native" | "ended" | "live", cwd: string): ReopenOption {
  return { resumable: true, candidate: {
    platform: "pi", agentId: "native:pi:session" as AgentId, sessionId: "session" as SessionId,
    type: "interactive", description: "pi", title: "Fix checkout navigation", origin,
    cwd, at: "2026-11-01T09:00:00.000Z" as IsoTimestamp,
  } };
}

test("reopen rows identify provider, checkout, recency and native ownership uncertainty", () => {
  const [item] = renderReopenItems([option("native", "C:\\projects\\feature")], new Date("2026-11-01T10:00:00.000Z"));
  assert.equal(item?.label, "Fix checkout navigation");
  assert.equal(item?.description, "Pi · feature");
  assert(item?.detail.includes("Last active 1h ago"));
  assert(item?.detail.includes("Native history"));
  assert(item?.detail.includes("May be open outside Aboard"));
  assert(item?.detail.includes("C:\\projects\\feature"));
  assert(!item?.detail.includes("Ended"));
  assert(!item?.label.includes("session"));
  assert.equal(reopenItemsForQuery([item!], "session")[0]?.alwaysShow, true);
});

test("same-named worktrees remain distinguishable by full checkout paths", () => {
  const items = renderReopenItems([option("native", "/one/feature"), option("native", "/two/feature")]);
  assert.equal(items[0]?.description, items[1]?.description);
  assert.notEqual(items[0]?.detail, items[1]?.detail);
});

test("tracked live and historical sessions describe focus versus resume", () => {
  const items = renderReopenItems([option("live", "/project"), option("ended", "/project")]);
  assert(items[0]?.detail.includes("Focus existing terminal"));
  assert(items[1]?.detail.includes("Aboard history"));
  assert(items[1]?.detail.includes("Resume conversation"));
});
