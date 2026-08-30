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
    views: Record<string, readonly { id: string; name?: string; when?: string }[]>;
    viewsWelcome?: readonly { view: string; when?: string; contents: string }[];
  };
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as Manifest;

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

test("the activity-bar views are bound to opposite initialization states", async () => {
  const { contributes } = await manifest();
  const views = new Map((contributes.views["aboard"] ?? []).map((view) => [view.id, view.when]));
  assert.equal(views.get("aboard.welcome"), "!aboard.initialized");
  // Three initialized views, each answering one question: what is running, what
  // the run is doing, and what happened recently.
  for (const id of ["aboard.fleet", "aboard.autoRun", "aboard.recentActivity"]) {
    assert.equal(views.get(id), "aboard.initialized", id);
  }
  assert.equal((contributes.views["aboard"] ?? []).find((view) => view.id === "aboard.fleet")?.name, "Agent Fleet");
});

test("Agent Fleet keeps New Manager first and leaves Manager resume to Recent Activity", async () => {
  const { contributes } = await manifest();
  const fleetWelcome = (contributes.viewsWelcome ?? []).filter((entry) => entry.view === "aboard.fleet");
  assert.deepEqual(fleetWelcome, [], "the fleet has no empty-state copy or duplicate launch actions");

  const fleetTitle = (contributes.menus["view/title"] ?? []).filter((entry) => entry.when?.includes("view == aboard.fleet"));
  for (const command of ["aboard.newManager", "aboard.resumeManager"]) {
    assert.equal(fleetTitle.some((entry) => entry.command === command), false, `${command} must not render in the fleet header`);
  }

  const activityResume = (contributes.menus["view/item/context"] ?? []).find((entry) => entry.command === "aboard.resumeManager");
  assert.match(activityResume?.when ?? "", /manager/, "Manager resume remains on its Recent Activity row");

  const icons = new Map(contributes.commands.map((entry) => [entry.command, entry.icon]));
  assert.equal(icons.get("aboard.resumeManager"), icons.get("aboard.activity.reopen"), "Manager resume uses the session-reopen icon");
});

test("every action rendered inline in a panel has an icon", async () => {
  const { contributes } = await manifest();
  const icons = new Map(contributes.commands.map((entry) => [entry.command, entry.icon]));
  const inline = (contributes.menus["view/item/context"] ?? []).filter((entry) => entry.group?.startsWith("inline"));
  for (const entry of inline) {
    assert.match(icons.get(entry.command) ?? "", /^\$\(.+\)$/, `${entry.command} would render as text in the panel`);
  }
});

test("reopening is always offered, and bulk fleet restoration no longer exists", async () => {
  const { contributes } = await manifest();
  // An ended conversation is always something the user may want back, so the
  // action is unconditional on the view title.
  const titleReopen = (contributes.menus["view/title"] ?? []).find((entry) => entry.command === "aboard.reopenSession");
  assert.match(titleReopen?.group ?? "", /^navigation@/, "Reopen a Session must be a visible title action");
  assert.equal(titleReopen?.when, "view == aboard.fleet");

  // Restore Fleet relaunched write-capable agents into a workspace nobody had
  // looked at since the crash. Its record survives in Recent Activity instead.
  const gone = ["aboard.restoreFleet", "aboard.removePausedSession"];
  for (const command of gone) {
    assert.equal(contributes.commands.some((entry) => entry.command === command), false, command);
    for (const menu of ["commandPalette", "view/title", "view/item/context"] as const) {
      assert.equal((contributes.menus[menu] ?? []).some((entry) => entry.command === command), false, `${command} in ${menu}`);
    }
  }
});

test("the auto-run card offers exactly the actions its state allows", async () => {
  const { contributes } = await manifest();
  const title = (contributes.menus["view/title"] ?? []).filter((entry) => (entry.when ?? "").includes("aboard.autoRun"));
  const when = (command: string) => title.find((entry) => entry.command === command)?.when ?? "";

  // Start is offered only with nothing unresolved: two runs competing for the
  // same branches is the failure this prevents. A forecast that already knows
  // it cannot start publishes "forecastBlocked" instead of "forecast", and the
  // exact-match Start clause hides the action there.
  assert.match(when("aboard.startAutoRun"), /aboard\.autoRunCard == idle/);
  assert.match(when("aboard.startAutoRun"), /aboard\.autoRunCard == forecast\b/);
  assert.match(when("aboard.startAutoRun"), /aboard\.autoRunCard == unavailable/);
  assert.doesNotMatch(when("aboard.startAutoRun"), /forecastBlocked/);
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.previewAutoRun"), false);
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.startAutoRunWithChrome"), false);
  // Resume appears only once validation has said the run may continue — never
  // while checking, and never when broken.
  assert.match(when("aboard.resumeAutoRun"), /aboard\.autoRunCard == recoverable/);
  for (const state of ["checking", "broken", "unsupported", "idle"]) {
    assert.doesNotMatch(when("aboard.resumeAutoRun"), new RegExp(`== ${state}`), state);
  }
  // Discard is the one action a broken or unsupported record still has.
  for (const state of ["recoverable", "broken", "unsupported"]) {
    assert.match(when("aboard.discardAutoRun"), new RegExp(`== ${state}`), state);
  }
  assert.match(when("aboard.stopAutoRun"), /active|waiting/);

  // The palette mirrors the same gating, so neither surface can offer a Start
  // the other refuses.
  const palette = new Map((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  assert.match(palette.get("aboard.startAutoRun") ?? "", /aboard\.autoRunCard == idle/);
  assert.doesNotMatch(palette.get("aboard.startAutoRun") ?? "", /forecastBlocked/);
  assert.match(palette.get("aboard.resumeAutoRun") ?? "", /aboard\.autoRunCard == recoverable/);
});

test("recent activity rows are offered only the actions their capabilities carry", async () => {
  const { contributes } = await manifest();
  const rows = (contributes.menus["view/item/context"] ?? []).filter((entry) => entry.command.startsWith("aboard.activity."));
  const when = (command: string) => rows.find((entry) => entry.command === command)?.when ?? "";
  assert.match(when("aboard.activity.openTerminal"), /terminal/);
  assert.match(when("aboard.activity.reopen"), /reopen/);
  assert.match(when("aboard.activity.openIssue"), /issue/);
  assert.match(when("aboard.activity.openPullRequest"), /pr/);

  const clear = (contributes.menus["view/title"] ?? []).find((entry) => entry.command === "aboard.activity.clear");
  assert.equal(clear?.when, "view == aboard.recentActivity");
  assert.match(clear?.group ?? "", /^navigation@/);
});
