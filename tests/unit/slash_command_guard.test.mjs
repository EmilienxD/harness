import assert from "node:assert/strict";
import test from "node:test";
import register from "../../harness/guards/slash-command-guard/pi/extension.ts";

function fixture() {
  let handler;
  let commands = [];
  const notifications = [];
  register({
    on: (event, callback) => { assert.equal(event, "input"); handler = callback; },
    getCommands: () => commands,
  });
  return {
    input: (text, source = "interactive") => handler({ text, source }, {
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    }),
    setCommands: (value) => { commands = value; },
    notifications,
  };
}

for (const source of ["interactive", "rpc", "extension"]) {
  test(`unknown slash commands are handled before inference for ${source} input`, () => {
    const f = fixture();
    assert.deepEqual(f.input("/typo private arguments", source), { action: "handled" });
    assert.deepEqual(f.notifications, [{ message: "Command /typo not found.", level: "error" }]);
  });
}

for (const text of ["/", "/ missing", "/skill:missing", "/known-suffix", "/tmp/file", "//comment", "/TYPO"]) {
  test(`blocks unresolved invocation ${JSON.stringify(text)}`, () => {
    const f = fixture();
    f.setCommands([{ name: "known", source: "prompt" }]);
    assert.deepEqual(f.input(text), { action: "handled" });
    assert.equal(f.notifications.length, 1);
  });
}

for (const text of ["", "ordinary message", "discuss /typo", "`/typo`", "\n/typo", " /typo"]) {
  test(`does not change non-slash-leading input ${JSON.stringify(text)}`, () => {
    const f = fixture();
    assert.deepEqual(f.input(text), { action: "continue" });
    assert.deepEqual(f.notifications, []);
  });
}

test("resolved skills and prompts retain their native delimiter rules", () => {
  const f = fixture();
  f.setCommands([
    { name: "skill:known", source: "skill" },
    { name: "template", source: "prompt" },
  ]);
  for (const text of ["/skill:known", "/skill:known arguments\non two lines", "/template", "/template\targs", "/template\nargs"]) {
    assert.deepEqual(f.input(text), { action: "continue" });
  }
  for (const text of ["/skill:known\targs", "/skill:known\nargs", "/skill:known-suffix", "/template-suffix"]) {
    assert.deepEqual(f.input(text), { action: "handled" });
  }
});

test("resource changes are observed on the next input", () => {
  const f = fixture();
  assert.deepEqual(f.input("/added"), { action: "handled" });
  f.setCommands([{ name: "added", source: "prompt" }]);
  assert.deepEqual(f.input("/added"), { action: "continue" });
  f.setCommands([]);
  assert.deepEqual(f.input("/added"), { action: "handled" });
});
