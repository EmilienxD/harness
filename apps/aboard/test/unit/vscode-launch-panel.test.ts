import assert from "node:assert/strict";
import test from "node:test";

import {
  LAUNCH_ACTIONS,
  LAUNCH_VIEW_ID,
  launchRow,
  registerLaunchPanel,
  type LaunchAction,
  type LaunchPanelProvider,
} from "../../src/vscode/launch-panel.js";

test("one labelled row per provider, each with its own product icon", () => {
  assert.deepEqual(LAUNCH_ACTIONS.map((action) => [action.label, action.icon]), [
    ["Run Claude Code", "claude"],
    ["Run Codex", "openai"],
  ]);
});

test("a row runs its own command when clicked and never expands", () => {
  for (const action of LAUNCH_ACTIONS) {
    const row = launchRow(action);
    assert.equal(row.label, action.label);
    assert.equal(row.icon, action.icon);
    // The label doubles as the command title, so nothing else has to be kept in step.
    assert.deepEqual(row.command, { command: action.command, title: action.label });
    // The hover play button is the same command reached a second way, so the row
    // and its inline action can never drift apart.
    assert.equal(row.contextValue, action.contextValue);
  }
  assert.equal(new Set(LAUNCH_ACTIONS.map((action) => action.contextValue)).size, LAUNCH_ACTIONS.length, "each row needs its own menu identity");
});

test("the view holds every action at the root and gives no action children", () => {
  let registered: { viewId: string; provider: LaunchPanelProvider } | undefined;
  const disposable = registerLaunchPanel({
    registerTreeDataProvider: (viewId, provider) => { registered = { viewId, provider }; return { dispose() {} }; },
  });
  assert.equal(registered?.viewId, LAUNCH_VIEW_ID);
  assert.ok(disposable);

  const provider = registered.provider;
  const roots = provider.getChildren();
  assert.deepEqual(roots.map((action: LaunchAction) => action.command), ["aboard.runClaudeCode", "aboard.runCodex"]);
  for (const root of roots) assert.deepEqual(provider.getChildren(root), []);
});
