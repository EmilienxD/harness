import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import register from "../../harness/productivity/turn-timer/pi/extension.ts";

function fixture(t, hasUI = true) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handlers = new Map();
  const labels = [];
  const widgets = new Map();
  const ctx = { hasUI, ui: {
    theme: { fg: (color, text) => { assert.equal(color, "muted"); return text; } },
    setWorkingMessage: (text) => labels.push(text),
    setWidget: (key, content) => { if (content) widgets.set(key, content); else widgets.delete(key); },
  } };
  register({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event) => handlers.get(event)?.({}, ctx);
  t.after(() => emit("session_shutdown"));
  return {
    labels, widgets, emit,
    advance(ms) { now += ms; t.mock.timers.tick(ms); },
  };
}

test("updates elapsed UI text, resets at user input and survives loop restarts", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.emit("input"), { action: "continue" });
  f.advance(1000);
  f.emit("agent_start");
  assert.equal(f.labels.at(-1), "Working · 0m 01s");
  f.advance(1509000);
  assert.equal(f.labels.at(-1), "Working · 25m 10s");
  f.emit("agent_end");
  f.emit("agent_start");
  f.advance(1000);
  assert.equal(f.labels.at(-1), "Working · 25m 11s");
  f.emit("input");
  assert.equal(f.labels.at(-1), "Working · 0m 00s");
  f.advance(1000);
  assert.equal(f.labels.at(-1), "Working · 0m 01s");
});

test("completion retains a frozen Worked line without a spinner until next input", (t) => {
  const f = fixture(t);
  f.emit("agent_start");
  f.advance(1510000);
  f.emit("agent_settled");
  assert.deepEqual([...f.widgets.values()], [["Worked · 25m 10s"]]);
  const count = f.labels.length;
  f.advance(10000);
  f.emit("agent_settled");
  assert.equal(f.labels.length, count);
  assert.deepEqual([...f.widgets.values()], [["Worked · 25m 10s"]]);
  f.emit("input");
  assert.equal(f.widgets.size, 0);
  f.emit("agent_start");
  assert.equal(f.labels.at(-1), "Working · 0m 00s");
});

for (const boundary of ["session_switch", "session_shutdown"]) {
  test(`${boundary} restores defaults and disposes the timer idempotently`, (t) => {
    const f = fixture(t);
    f.emit("agent_start");
    f.advance(2000);
    f.emit(boundary);
    assert.equal(f.labels.at(-1), undefined);
    const count = f.labels.length;
    f.advance(10000);
    f.emit(boundary);
    assert.equal(f.labels.length, count);
    f.emit("agent_start");
    assert.equal(f.labels.at(-1), "Working · 0m 00s");
  });
}

test("non-UI runs do not schedule work or change messages", (t) => {
  const f = fixture(t, false);
  f.emit("input");
  f.emit("agent_start");
  f.advance(5000);
  f.emit("agent_settled");
  assert.deepEqual(f.labels, []);
});
