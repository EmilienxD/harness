import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_STORAGE_KEY, resizeWorkspacePreset, validateWorkspacePreset, WorkspacePresetStore } from "../../src/domain/workspace-presets.js";

function storage() {
  const values = new Map<string, unknown>();
  return { get<T>(key: string): T | undefined { return values.get(key) as T | undefined; }, async update(key: string, value: unknown) { values.set(key, structuredClone(value)); } };
}

test("first launch offers the six templates and defaults to vertically stacked ChatGPT agents", () => {
  const store = new WorkspacePresetStore(storage(), ["claude", "chatgpt"]);
  assert.equal(store.presets.length, 6);
  assert.deepEqual([store.preferredPreset.columns, store.preferredPreset.rows, store.preferredPreset.panes], [1, 2, [{ providers: ["chatgpt"] }, { providers: ["chatgpt"] }]]);
  assert.deepEqual(store.presets.map((preset) => [preset.columns, preset.rows, preset.panes.map((pane) => pane.providers)]), [
    [1, 2, [["chatgpt"], ["chatgpt"]]],
    [1, 2, [["claude"], ["claude"]]],
    [2, 1, [["claude"], ["chatgpt"]]],
    [4, 2, [["chatgpt"], ["chatgpt"], ["chatgpt"], ["chatgpt"], ["chatgpt"], ["chatgpt"], ["chatgpt"], ["chatgpt"]]],
    [2, 2, [["claude"], ["chatgpt"], ["claude"], ["chatgpt"]]],
    [1, 1, [["claude", "chatgpt"]]],
  ]);
});

test("saving a starter preset with the same name updates it in place and survives reload", async () => {
  const saved = storage();
  const store = new WorkspacePresetStore(saved, ["claude", "chatgpt"]);
  const original = store.preferredPreset;
  const updated = await store.save({ ...original, panes: [{ providers: ["claude"] }, { providers: [] }] });
  assert.equal(updated.id, original.id);
  const reloaded = new WorkspacePresetStore(saved, ["claude", "chatgpt"]);
  assert.equal(reloaded.presets.length, 6);
  assert.deepEqual(reloaded.preferredPreset.panes, [{ providers: ["claude"] }, { providers: [] }]);
  await reloaded.delete(updated.id);
  assert.equal(new WorkspacePresetStore(saved, ["claude", "chatgpt"]).presets.some((preset) => preset.id === original.id), false);
});

test("Save updates the selected preset name and config while Save as preserves the original", async () => {
  const saved = storage();
  const store = new WorkspacePresetStore(saved, ["claude", "chatgpt"]);
  const edited = await store.save({ ...store.preferredPreset, name: "My agents", panes: [{ providers: [] }, { providers: ["claude", "chatgpt"] }] });
  assert.equal(edited.id, "builtin.chatgpt-pair");
  const copy = await store.saveAs({ ...edited, name: "Second team", panes: [{ providers: ["chatgpt"] }, { providers: [] }] });
  assert.notEqual(copy.id, edited.id);
  assert.equal(store.presets.find((preset) => preset.id === edited.id)?.name, "My agents");
  await assert.rejects(store.saveAs({ ...copy, name: "  Second team  " }), /different name/);
  const renamed = await store.save({ ...copy, name: "Other agents" });
  assert.equal(renamed.id, copy.id);
  await store.delete(edited.id);
  await store.delete("builtin.tabs");
  await store.setPreferred(copy.id);
  const reloaded = new WorkspacePresetStore(saved, ["claude", "chatgpt"]);
  assert.equal(reloaded.preferredPreset.name, "Other agents");
  assert.deepEqual(reloaded.preferredPreset.panes, [{ providers: ["chatgpt"] }, { providers: [] }]);
  assert.ok(!reloaded.presets.some((preset) => preset.id === "builtin.chatgpt-pair"));
  assert.ok(!reloaded.presets.some((preset) => preset.id === "builtin.tabs" || preset.id === edited.id));
});

test("loading damaged personal presets preserves valid siblings and reports actionable diagnostics", async () => {
  const saved = storage();
  const diagnostics: string[] = [];
  await saved.update(PRESET_STORAGE_KEY, { version: 1, presets: [
    { id: "valid", name: "Valid", columns: 1, rows: 1, panes: [{ providers: ["claude"] }] },
    { id: "bad", name: "Bad", columns: 1, rows: 1, panes: [{ providers: ["pi"] }] },
  ], preferredId: "valid" });
  const store = new WorkspacePresetStore(saved, ["claude", "chatgpt"], (message) => diagnostics.push(message));
  assert.equal(store.preferredPreset.id, "valid");
  assert.equal(store.presets.length, 7);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /unavailable provider: pi/);
});

test("grid shrinking drops removed draft panes and preserves the original preset", () => {
  const store = new WorkspacePresetStore(storage(), ["claude", "chatgpt"]);
  const preset = store.preferredPreset;
  assert.deepEqual(resizeWorkspacePreset(preset, 1, 1).panes, [{ providers: ["chatgpt"] }]);
  assert.equal(preset.panes.length, 2);
  assert.equal(resizeWorkspacePreset(preset, 1, 1).panes.length, 1);
  assert.throws(() => resizeWorkspacePreset(preset, 5, 2), /nine panes/);
  assert.throws(() => validateWorkspacePreset({ ...preset, panes: [{ providers: ["pi"] }, { providers: [] }] }, ["claude", "chatgpt"]), /unavailable provider/);
});

test("an already open launcher merges later personal preset changes before saving", async () => {
  const global = storage();
  const first = new WorkspacePresetStore(global, ["claude", "chatgpt"]);
  const second = new WorkspacePresetStore(global, ["claude", "chatgpt"]);
  const firstPreset = await first.saveAs({ ...first.preferredPreset, name: "First window" });
  const secondPreset = await second.saveAs({ ...second.preferredPreset, name: "Second window" });
  const reloaded = new WorkspacePresetStore(global, ["claude", "chatgpt"]);
  assert.ok(reloaded.presets.some((preset) => preset.id === firstPreset.id));
  assert.ok(reloaded.presets.some((preset) => preset.id === secondPreset.id));
});
