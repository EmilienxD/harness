import assert from "node:assert/strict";
import test from "node:test";

import { formatTimestamp } from "../src/shared/time.js";

test("a timestamp from today shows only its time", () => {
  const now = new Date("2026-08-31T15:00:00");
  const value = new Date("2026-08-31T09:05:00").toISOString();
  const expected = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value));
  assert.equal(formatTimestamp(value, now), expected);
  assert.equal(formatTimestamp(value, now).includes("2026"), false);
});

test("a timestamp from another day keeps its date", () => {
  const now = new Date("2026-08-31T15:00:00");
  const value = new Date("2026-08-30T09:05:00").toISOString();
  const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  assert.equal(formatTimestamp(value, now), expected);
  assert.equal(formatTimestamp(value, now).includes("2026"), true);
});

test("an unparseable timestamp is shown as-is", () => {
  assert.equal(formatTimestamp("not a date"), "not a date");
});
