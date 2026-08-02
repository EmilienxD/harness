import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Manifest {
  contributes: {
    commands: readonly { command: string }[];
    menus: { commandPalette?: readonly { command: string; when?: string }[] };
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
