import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Manifest {
  activationEvents: readonly string[];
  files: readonly string[];
  contributes: {
    jsonValidation: readonly { fileMatch: string; url: string }[];
    commands: readonly { command: string; title?: string; category?: string; icon?: string }[];
    menus: {
      commandPalette?: readonly { command: string; when?: string }[];
      "view/title"?: readonly { command: string; when?: string; group?: string }[];
      "view/item/context"?: readonly { command: string; when?: string; group?: string }[];
    };
    views: Record<string, readonly { id: string; name?: string; when?: string; type?: string; initialSize?: number }[]>;
    viewsWelcome?: readonly { view: string; when?: string; contents: string }[];
    configuration: { properties: Record<string, unknown> };
  };
}

test("launch command, model, effort, and denials live only in .harness/config.json", async () => {
  const { contributes } = await manifest();
  const settings = Object.keys(contributes.configuration.properties);
  assert.equal(settings.includes("aboard.launch.claudeCommand"), false);
  assert.equal(settings.includes("aboard.launch.effort"), false);
  assert.equal(settings.includes("aboard.launch.maxInlinePromptChars"), true);
});

const manifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as Manifest;

test("initialized projects activate Aboard without waiting for unrelated extension startup", async () => {
  const { activationEvents } = await manifest();
  assert.ok(activationEvents.includes("workspaceContains:.abd/scaffold.json"));
});

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

test("Agent Fleet exposes Run Agent and one shared reopen action", async () => {
  const { contributes } = await manifest();
  const fleetWelcome = (contributes.viewsWelcome ?? []).filter((entry) => entry.view === "aboard.fleet");
  assert.deepEqual(fleetWelcome, [], "the fleet has no empty-state copy or duplicate launch actions");

  assert.deepEqual(
    contributes.commands.filter((entry) => ["aboard.runAgent", "aboard.reopenSession"].includes(entry.command)).map((entry) => entry.title),
    ["Run Agent", "Reopen a Session"],
  );
});

test("the unified workspace launcher is a webview above the fleet and retains direct provider commands", async () => {
  const { contributes } = await manifest();
  const commands = new Map(contributes.commands.map((entry) => [entry.command, entry]));
  for (const [command, label] of [
    ["aboard.runClaudeCode", "Run Claude Code"],
    ["aboard.runCodex", "Run Codex"],
    ["aboard.runPi", "Run Pi"],
  ] as const) {
    assert.equal(commands.get(command)?.title, label);
    assert.equal(contributes.menus.commandPalette?.find((entry) => entry.command === command)?.when, "aboard.initialized");
    assert.equal((contributes.menus["view/title"] ?? []).some((entry) => entry.command === command), false, `${label} must not sit in a view title`);
    assert.equal((contributes.menus["view/item/context"] ?? []).some((entry) => entry.command === command), false);
  }
  assert.ok(commands.has("aboard.launchWorkspace"));
  for (const removed of ["aboard.runAgentInActivePane", "aboard.resumeRemoteAgent"]) assert.equal(commands.has(removed), false);
  assert.equal(commands.has("aboard.applyAgentLayout"), false, "the launcher cannot reapply layouts");
  const views = contributes.views["aboard"] ?? [];
  const panel = views.find((view) => view.id === "aboard.launch");
  assert.equal(panel?.type, "webview");
  assert.equal(panel?.when, "aboard.initialized");
  assert.ok(views.indexOf(panel!) < views.findIndex((view) => view.id === "aboard.fleet"), "the launcher belongs above Agent Fleet");
});

test("the launch file has editor validation for the provider schema", async () => {
  const { contributes, files } = await manifest();
  assert.deepEqual(contributes.jsonValidation, [{ fileMatch: "**/.harness/config.json", url: "./assets/config.schema.json" }]);
  assert.ok(files.includes("assets/config.schema.json"), "the registered schema must ship in the VSIX");
});

test("every action rendered inline in a panel has an icon", async () => {
  const { contributes } = await manifest();
  const icons = new Map(contributes.commands.map((entry) => [entry.command, entry.icon]));
  const inline = (contributes.menus["view/item/context"] ?? []).filter((entry) => entry.group?.startsWith("inline"));
  for (const entry of inline) {
    assert.match(icons.get(entry.command) ?? "", /^\$\(.+\)$/, `${entry.command} would render as text in the panel`);
  }
});

test("button labels omit the Aboard prefix while commands retain the Aboard category", async () => {
  const { contributes } = await manifest();
  for (const command of contributes.commands.filter((entry) => entry.category === "Aboard")) {
    assert.doesNotMatch(command.title ?? "", /^Aboard:/, command.command);
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
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.continueAutoRun"), false);
  assert.equal(JSON.stringify(contributes.menus).includes("aboard.continueAutoRun"), false);
  assert.equal(JSON.stringify(contributes.menus).includes("aboard.autoRunWaiting"), false);
  assert.equal("aboard.autoRun.pollSeconds" in contributes.configuration.properties, false);
  const title = (contributes.menus["view/title"] ?? []).filter((entry) => (entry.when ?? "").includes("aboard.autoRun"));
  const inline = contributes.menus["view/item/context"] ?? [];
  const action = (command: string) => inline.find((entry) => entry.command === command);

  // The title keeps Start discoverable when the card cannot offer it.
  const start = action("aboard.startAutoRun");
  assert.match(start?.group ?? "", /^inline@/, "Start Auto Run must be the card's inline action");
  assert.equal(title.find((entry) => entry.command === "aboard.startAutoRun")?.when,
    "view == aboard.autoRun && aboard.initialized && !aboard.autoRunActive");

  // Start is offered only for a successfully checked, ready preview. Idle,
  // failed, refreshing, empty, and blocked forecasts must be reviewed first.
  assert.equal(start?.when, "viewItem == aboard.autoRun.forecast");
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.previewAutoRun"), false);
  assert.equal(contributes.commands.some((entry) => entry.command === "aboard.startAutoRunWithChrome"), false);
  // Resume appears only once validation has said the run may continue; never
  // while checking, and never when broken.
  const resume = action("aboard.resumeAutoRun");
  assert.match(resume?.when ?? "", /aboard\.autoRun\.recoverable/);
  assert.match(resume?.group ?? "", /^inline@1$/);
  for (const state of ["checking", "broken", "idle"]) {
    assert.doesNotMatch(resume?.when ?? "", new RegExp(`aboard\\.autoRun\\.${state}`), state);
  }
  // Discard is the card's inline action, never a 3-dots menu entry: it is the
  // only command that menu would carry, and the inline button sits right below.
  assert.equal(title.some((entry) => entry.command === "aboard.discardAutoRun"), false, "Discard must not sit in the view title");
  const discardInline = action("aboard.discardAutoRun");
  assert.match(discardInline?.group ?? "", /^inline@/, "Discard Auto Run must be the card's inline action");
  for (const state of ["recoverable", "broken"]) {
    assert.match(discardInline?.when ?? "", new RegExp(state), state);
  }
  const stop = action("aboard.stopAutoRun");
  assert.match(stop?.when ?? "", /active|waiting/);
  assert.equal(stop?.group, "inline@1");
  assert.equal(title.some((entry) => entry.command === "aboard.stopAutoRun" || entry.command === "aboard.resumeAutoRun"), false,
    "run controls must appear only once, on the state row");

  const pullRequest = action("aboard.autoRun.openPullRequest");
  const currentIssue = action("aboard.autoRun.openCurrentIssue");
  assert.match(pullRequest?.when ?? "", /aboard\.autoRunHasPullRequest/);
  assert.equal(pullRequest?.group, "inline@2");
  assert.equal(currentIssue?.group, "inline@3");

  const issueButtons = inline.filter((entry) => entry.command === "aboard.openIssue" && (entry.when ?? "").includes("aboard.autoRun.issue"));
  assert.equal(issueButtons.length, 1, "each issue row must contribute one GitHub issue button");

  // The palette remains discoverable while there is no active run.
  const palette = new Map((contributes.menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
  assert.equal(palette.get("aboard.startAutoRun"), "aboard.initialized && !aboard.autoRunActive");
  assert.match(palette.get("aboard.resumeAutoRun") ?? "", /aboard\.autoRunCard == recoverable/);
});

test("recent activity rows are offered only the actions their capabilities carry", async () => {
  const { contributes } = await manifest();
  const rows = (contributes.menus["view/item/context"] ?? []).filter((entry) => entry.command.startsWith("aboard.activity."));
  for (const entry of rows) {
    assert.match(entry.when ?? "", /^view == aboard\.recentActivity && /,
      `${entry.command} must not leak into other views with matching row capabilities`);
  }
  const when = (command: string) => rows.find((entry) => entry.command === command)?.when ?? "";
  assert.match(when("aboard.activity.openTerminal"), /terminal/);
  assert.match(when("aboard.activity.reopen"), /reopen/);
  assert.match(when("aboard.activity.openIssue"), /issue/);
  assert.match(when("aboard.activity.openPullRequest"), /pr/);

  const clear = (contributes.menus["view/title"] ?? []).find((entry) => entry.command === "aboard.activity.clear");
  assert.equal(clear?.when, "view == aboard.recentActivity");
  assert.match(clear?.group ?? "", /^navigation@/);
});
