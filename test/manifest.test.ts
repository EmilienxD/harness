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

test("a stale scaffold gets a dedicated update action instead of Initialize", async () => {
  const { contributes } = await manifest();
  const welcome = (contributes.viewsWelcome ?? []).filter((entry) => entry.view === "aboard.welcome");
  assert.ok(welcome.some((entry) => entry.when === "aboard.scaffoldUpdateRequired" && entry.contents.includes("command:aboard.updateProject")));
  const palette = new Map((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  assert.match(palette.get("aboard.initializeProject") ?? "", /!aboard\.scaffoldUpdateRequired/u);
  assert.match(palette.get("aboard.updateProject") ?? "", /aboard\.scaffoldUpdateRequired/u);
});

test("Agent Fleet keeps New Manager first, and the Manager reopens through the shared reopen action", async () => {
  const { contributes } = await manifest();
  const fleetWelcome = (contributes.viewsWelcome ?? []).filter((entry) => entry.view === "aboard.fleet");
  assert.deepEqual(fleetWelcome, [], "the fleet has no empty-state copy or duplicate launch actions");

  const fleetTitle = (contributes.menus["view/title"] ?? []).filter((entry) => entry.when?.includes("view == aboard.fleet"));
  assert.equal(fleetTitle.some((entry) => entry.command === "aboard.newManager"), false, "aboard.newManager must not render in the fleet header");

  // There is one word for getting a session back. No separate Manager-resume
  // command, palette entry, or activity-row button survives; a Manager row uses
  // the same reopen action as every other session.
  const all = [
    ...(contributes.menus["view/title"] ?? []),
    ...(contributes.menus["view/item/context"] ?? []),
    ...(contributes.menus.commandPalette ?? []),
  ];
  assert.equal(all.some((entry) => entry.command === "aboard.resumeManager"), false, "aboard.resumeManager must not survive anywhere");
  assert.equal((contributes.commands ?? []).some((entry) => entry.command === "aboard.resumeManager"), false, "aboard.resumeManager must not be a contributed command");
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

  // Start lives on the card itself as its inline action; repeating it in the
  // view title would only duplicate the button one row below.
  const start = (contributes.menus["view/item/context"] ?? []).find((entry) => entry.command === "aboard.startAutoRun");
  assert.match(start?.group ?? "", /^inline@/, "Start Auto Run must be the card's inline action");
  assert.equal(title.some((entry) => entry.command === "aboard.startAutoRun"), false, "Start Auto Run must not also sit in the view title");

  // Start is offered only for a successfully checked, ready preview. Idle,
  // failed, refreshing, empty, and blocked forecasts must be reviewed first.
  assert.equal(start?.when, "viewItem == aboard.autoRun.forecast");
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.previewAutoRun"), false);
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.startAutoRunWithChrome"), false);
  // Resume appears only once validation has said the run may continue — never
  // while checking, and never when broken.
  assert.match(when("aboard.resumeAutoRun"), /aboard\.autoRunCard == recoverable/);
  for (const state of ["checking", "broken", "unsupported", "idle"]) {
    assert.doesNotMatch(when("aboard.resumeAutoRun"), new RegExp(`== ${state}`), state);
  }
  // Discard is the card's inline action, never a 3-dots menu entry: it is the
  // only command that menu would carry, and the inline button sits right below.
  assert.equal(title.some((entry) => entry.command === "aboard.discardAutoRun"), false, "Discard must not sit in the view title");
  const discardInline = (contributes.menus["view/item/context"] ?? []).find((entry) => entry.command === "aboard.discardAutoRun");
  assert.match(discardInline?.group ?? "", /^inline@/, "Discard Auto Run must be the card's inline action");
  for (const state of ["recoverable", "broken", "unsupported"]) {
    assert.match(discardInline?.when ?? "", new RegExp(state), state);
  }
  assert.match(when("aboard.stopAutoRun"), /active|waiting/);

  // The palette mirrors the same gating, so neither surface can offer a Start
  // the other refuses.
  const palette = new Map((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  assert.equal(palette.get("aboard.startAutoRun"), "aboard.initialized && aboard.autoRunCard == forecast");
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
