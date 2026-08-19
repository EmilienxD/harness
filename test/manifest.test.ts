import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Manifest {
  contributes: {
    commands: readonly { command: string; title?: string; icon?: string }[];
    menus: {
      commandPalette?: readonly { command: string; when?: string }[];
      "view/title"?: readonly { command: string; when?: string; group?: string }[];
      "view/item/context"?: readonly { command: string; when?: string; group?: string }[];
    };
    views: Record<string, readonly { id: string; when?: string }[]>;
  };
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as Manifest;

// The uninitialized workspace shows exactly one aboard gesture: the welcome
// view's Initialize button. Every other feature waits for `aboard.initialized`
// — a palette command without an explicit rule is shown unconditionally by
// VS Code, so absence is a leak, not a default.
test("every command except Initialize is gated out of an uninitialized project", async () => {
  const { contributes } = await manifest();
  const palette = new Map((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  for (const { command } of contributes.commands) {
    const when = palette.get(command);
    assert.notEqual(when, undefined, `${command} has no commandPalette rule, so VS Code shows it unconditionally`);
    if (command === "aboard.initializeProject") {
      assert.match(when!, /!aboard\.initialized/, "Initialize is the one command visible before initialization");
      continue;
    }
    assert.ok(
      when === "false" || (when!.includes("aboard.initialized") && !when!.includes("!aboard.initialized")),
      `${command} must be hidden entirely or require aboard.initialized (when: ${when})`,
    );
  }
});

test("the two activity-bar views are bound to opposite initialization states", async () => {
  const { contributes } = await manifest();
  const views = new Map((contributes.views["aboard"] ?? []).map((view) => [view.id, view.when]));
  assert.equal(views.get("aboard.welcome"), "!aboard.initialized");
  assert.equal(views.get("aboard.fleet"), "aboard.initialized");
});

test("fleet recovery actions are visible where the stranded record is shown", async () => {
  const { contributes } = await manifest();
  const titleRestore = (contributes.menus["view/title"] ?? []).find((entry) => entry.command === "aboard.restoreFleet");
  assert.match(titleRestore?.group ?? "", /^navigation@/, "Restore Fleet must be a visible title action, not overflow-only");

  // Reopening is not a recovery state like Restore Fleet, which appears only
  // while a restorable fleet exists: an ended conversation is always something
  // the user may want back, so the action is always on the view title.
  const titleReopen = (contributes.menus["view/title"] ?? []).find((entry) => entry.command === "aboard.reopenSession");
  assert.match(titleReopen?.group ?? "", /^navigation@/, "Reopen a Session must be a visible title action");
  assert.equal(titleReopen?.when, "view == aboard.fleet");

  const rowRemove = (contributes.menus["view/item/context"] ?? []).find((entry) => entry.command === "aboard.removePausedSession");
  assert.match(rowRemove?.when ?? "", /paused\|orphaned/, "both recoverable and orphaned disconnected rows need cleanup");
  assert.match(rowRemove?.group ?? "", /^inline@/, "cleanup must be visible on the row without discovering its context menu");
  const removeCommand = contributes.commands.find((entry) => entry.command === "aboard.removePausedSession");
  assert.equal(removeCommand?.icon, "$(trash)");
});
