import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { WebviewView, WebviewViewProvider } from "vscode";
import { WorkspacePresetStore } from "../../src/domain/workspace-presets.js";
import { registerLaunchPanel, type LauncherRequest, type LaunchPanelOptions } from "../../src/vscode/launch-panel.js";

async function mount(options: LaunchPanelOptions) {
  let provider!: WebviewViewProvider;
  let receive!: (message: unknown) => Promise<void>;
  const messages: Record<string, unknown>[] = [];
  const webview = { options: {}, html: "", onDidReceiveMessage(handler: typeof receive) { receive = handler; return { dispose() {} }; }, postMessage(message: Record<string, unknown>) { messages.push(message); return Promise.resolve(true); } };
  const registration = registerLaunchPanel({ registerWebviewViewProvider(_id, value) { provider = value; return { dispose() {} }; } }, options);
  await provider.resolveWebviewView({ webview } as unknown as WebviewView, {} as never, {} as never);
  return { receive, messages, registration, html: webview.html };
}

function store() {
  const saved = new Map<string, unknown>();
  return new WorkspacePresetStore({ get: <T>(key: string) => saved.get(key) as T | undefined, update: async (key, value) => { saved.set(key, structuredClone(value)); } }, ["claude", "chatgpt"]);
}
const providers = [{ id: "chatgpt", displayName: "Codex", icon: "openai" }];

/** Execute the shipped webview with only the DOM operations its controls use. */
async function browser(panel: Awaited<ReturnType<typeof mount>>) {
  class Element {
    value = ""; textContent = ""; hidden = false; disabled = false; checked = false;
    style = {}; classList = { toggle() {} }; children: Element[] = [];
    attributes = new Map<string, string>();
    onclick?: () => void; oninput?: () => void; onchange?: () => void;
    onkeydown?: (event: { key: string; preventDefault(): void }) => void;
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    replaceChildren(...children: Element[]) { this.children = children; }
    append(...children: Element[]) { this.children.push(...children); }
    focus() {}
    contains(target: Element): boolean { return target === this || this.children.some((child) => child.contains(target)); }
  }
  const elements = new Map([...panel.html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)].map((match) => [match[2]!, new Element(match[1]!)]));
  const events = new Map<string, (event: unknown) => void>();
  const outgoing: unknown[] = [];
  runInNewContext(panel.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => outgoing.push(message) }),
    document: { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new Element(tag), querySelectorAll: () => [...elements.values()], addEventListener() {} },
    window: { addEventListener: (name: string, handler: (event: unknown) => void) => events.set(name, handler) },
  });
  let delivered = 0;
  async function flush() {
    while (outgoing.length) await panel.receive(outgoing.shift());
    while (delivered < panel.messages.length) events.get("message")!({ data: panel.messages[delivered++] });
  }
  await flush();
  return { elements, flush };
}

test("one editable preset selector supports selection, renaming drafts, and resetting the name and layout", async () => {
  const presets = store();
  const panel = await mount({ store: presets, providers, launch: async () => {}, runAgent: async () => {} });
  const ui = await browser(panel);
  assert.equal(ui.elements.get("preset")?.tag, "input");
  for (const removed of ["name", "rename", "new"]) assert.equal(ui.elements.has(removed), false);
  const name = ui.elements.get("preset")!;
  name.value = "Changed name";
  name.oninput!();
  const columns = ui.elements.get("columns")!;
  columns.value = "2";
  columns.onchange!();
  name.onkeydown!({ key: "Escape", preventDefault() {} });
  assert.equal(name.value, "Changed name");
  ui.elements.get("reset")!.onclick!();
  assert.equal(name.value, "Codex pair (vertically stacked)");
  assert.equal(Number(columns.value), 1);
  ui.elements.get("presetToggle")!.onclick!();
  ui.elements.get("presetOptions")!.children[2]!.onclick!();
  await ui.flush();
  assert.equal(name.value, "Claude + Codex");
  assert.equal(Number(columns.value), 2);
  panel.registration.dispose();
});

test("Save includes name and config changes while Save as requires a different name and creates a copy", async () => {
  const presets = store();
  const panel = await mount({ store: presets, providers, launch: async () => {}, runAgent: async () => {} });
  const ui = await browser(panel);
  const name = ui.elements.get("preset")!;
  const columns = ui.elements.get("columns")!;
  const saveAs = ui.elements.get("saveAs")!;
  assert.equal(saveAs.disabled, true);
  name.value = "My team";
  name.oninput!();
  assert.equal(saveAs.disabled, false);
  columns.value = "2";
  columns.onchange!();
  ui.elements.get("save")!.onclick!();
  await ui.flush();
  const savedId = presets.preferredPreset.id;
  assert.equal(presets.presets.length, 6);
  assert.equal(savedId, "builtin.chatgpt-pair");
  assert.equal(name.value, "My team");
  assert.equal(presets.preferredPreset.columns, 2);
  const rows = ui.elements.get("rows")!;
  rows.value = "1";
  rows.onchange!();
  ui.elements.get("save")!.onclick!();
  await ui.flush();
  assert.equal(presets.presets.length, 6);
  assert.equal(presets.preferredPreset.id, savedId);
  assert.equal(presets.preferredPreset.rows, 1);
  assert.equal(saveAs.disabled, true);
  name.value = "  My team  ";
  name.oninput!();
  assert.equal(saveAs.disabled, true, "whitespace alone does not create a new name");
  name.value = "";
  name.oninput!();
  assert.equal(saveAs.disabled, true);
  name.value = "Second team";
  name.oninput!();
  columns.value = "3";
  columns.onchange!();
  saveAs.onclick!();
  await ui.flush();
  assert.equal(presets.presets.length, 7);
  assert.notEqual(presets.preferredPreset.id, savedId);
  assert.equal(presets.preferredPreset.name, "Second team");
  assert.equal(presets.preferredPreset.columns, 3);
  assert.equal(presets.presets.find((preset) => preset.id === savedId)?.name, "My team");
  assert.equal(presets.presets.find((preset) => preset.id === savedId)?.columns, 2);
  assert.equal(saveAs.disabled, true);
  name.value = "Unsaved name";
  name.oninput!();
  columns.value = "4";
  columns.onchange!();
  ui.elements.get("reset")!.onclick!();
  assert.equal(name.value, "Second team");
  assert.equal(Number(columns.value), 3);
  assert.equal(saveAs.disabled, true);
  assert.equal(Number(rows.value), 1);
  panel.registration.dispose();
});

test("workspace launch submits a preset and window choice, and rejects repeated submission while starting", async () => {
  const presets = store();
  const launches: LauncherRequest[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { receive, messages, registration } = await mount({
    store: presets, providers, runAgent: async () => {},
    launch: async (request) => { launches.push(request); await pending; },
  });
  await receive({ type: "ready" });
  assert.equal("destinations" in messages.at(-1)!, false);
  assert.equal("preferences" in messages.at(-1)!, false);
  const launch = receive({ type: "launch", preset: presets.preferredPreset, destination: "new", destinationId: "old-window", keepCurrentLayout: true });
  await receive({ type: "launch", preset: presets.preferredPreset, destination: "new" });
  finish();
  await launch;
  assert.deepEqual(launches, [{ preset: presets.preferredPreset, destination: "new" }]);
  registration.dispose();
});

test("Empty stays a terminal assignment through Save, selection, and Launch layout", async () => {
  const presets = store();
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: presets, providers, launch: async (request) => { launches.push(request); }, runAgent: async () => {} });
  const ui = await browser(panel);
  const chooseEmpty = () => {
    const select = ui.elements.get("assignments")!.children[0]!.children[0]!;
    select.value = "";
    select.onchange!();
  };
  chooseEmpty();
  ui.elements.get("preview")!.children[1]!.onclick!();
  chooseEmpty();
  assert.equal(ui.elements.get("launch")!.disabled, false, "a layout of ordinary terminals can launch");
  ui.elements.get("save")!.onclick!();
  await ui.flush();
  assert.deepEqual(presets.preferredPreset.panes, [{ providers: [""] }, { providers: [""] }]);
  ui.elements.get("launch")!.onclick!();
  await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(launches[0]?.preset.panes)), [{ providers: [""] }, { providers: [""] }]);
  panel.registration.dispose();
});

test("the workspace selector offers only Current window and New window and sends that choice", async () => {
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: store(), providers, launch: async (request) => { launches.push(request); }, runAgent: async () => {} });
  const ui = await browser(panel);
  const selector = ui.elements.get("destination");
  assert.ok(selector, "the workspace selector is visible");
  const options = panel.html.match(/<select id="destination">([\s\S]*?)<\/select>/)![1]!;
  assert.deepEqual([...options.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((match) => match[1]), ["Current window", "New window"]);
  assert.equal(selector.value, "new");
  selector.value = "current";
  ui.elements.get("launch")!.onclick!();
  await ui.flush();
  selector.value = "new";
  ui.elements.get("launch")!.onclick!();
  await ui.flush();
  assert.deepEqual(launches.map((request) => request.destination), ["current", "new"]);
  await panel.receive({ type: "launch", preset: store().preferredPreset, destination: "another-existing-window" });
  assert.equal(launches.length, 2, "a named existing workspace is never accepted");
  panel.registration.dispose();
});

test("Run Agent uses its local launcher without accepting a destination or active-pane mode", async () => {
  const calls: unknown[][] = [];
  const { receive, registration } = await mount({
    store: store(), providers, launch: async () => assert.fail("Run Agent must not start a workspace"),
    runAgent: async (...args: unknown[]) => { calls.push(args); },
  });
  await receive({ type: "run", destinationId: "old-window", activePane: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 1);
  assert.equal(typeof calls[0]![0], "function", "only the inline warning callback is passed");
  registration.dispose();
});

test("unavailable providers cannot start a workspace", async () => {
  const presets = store();
  const launches: LauncherRequest[] = [];
  const { receive, messages, registration } = await mount({
    store: presets, providers, launch: async (request) => { launches.push(request); }, runAgent: async () => {},
  });
  await receive({ type: "launch", destination: "new", preset: { ...presets.preferredPreset, panes: [{ providers: ["pi"] }, { providers: [] }] } });
  assert.deepEqual(launches, []);
  assert.equal(messages.filter((message) => message.type === "error").length, 1);
  registration.dispose();
});


test("checkout selection reveals the branch field and stays separate from saved layout presets", async () => {
  const presets = store();
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: presets, providers, runAgent: async () => {}, launch: async (request) => { launches.push(request); },
    checkoutChoices: async () => ({ nextPath: "/project-2", entries: [{ path: "/project-1", branch: "feature/one", available: true, dirty: true, agents: 2 }] }),
  });
  const ui = await browser(panel);
  assert.equal(ui.elements.get("newCheckout")!.hidden, true);
  const checkout = ui.elements.get("checkout")!;
  checkout.value = "new"; checkout.onchange!();
  assert.equal(ui.elements.get("newCheckout")!.hidden, false);
  assert.equal(ui.elements.get("launch")!.disabled, true);
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "/project-2");
  assert.equal(ui.elements.has("useExistingBranch"), false);
  assert.equal(ui.elements.has("startPoint"), false);
  assert.equal(panel.html.includes("Uncommitted changes stay in the source checkout."), false);
  ui.elements.get("branch")!.value = "feature/two";
  ui.elements.get("branch")!.oninput!();
  assert.equal(ui.elements.get("launch")!.disabled, true, "wait for branch validation");
  await ui.flush();
  assert.equal(ui.elements.get("launch")!.disabled, false);
  ui.elements.get("save")!.onclick!(); await ui.flush();
  assert.equal("checkout" in presets.preferredPreset, false);
  ui.elements.get("launch")!.onclick!(); await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(launches[0]?.checkout)), { kind: "new", branch: "feature/two" });
  checkout.value = "existing:/project-1"; checkout.onchange!();
  ui.elements.get("destination")!.value = "current";
  ui.elements.get("destination")!.onchange!();
  assert.equal(ui.elements.get("newCheckout")!.hidden, true);
  assert.equal(ui.elements.get("checkoutWarning")!.hidden, false);
  ui.elements.get("launch")!.onclick!(); await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(launches[1]?.checkout)), { kind: "existing", path: "/project-1" });
  panel.registration.dispose();
});

test("checkout paths and panel errors abbreviate home without changing launch paths", async () => {
  const path = join(homedir(), "projects", "project-1");
  const nextPath = join(homedir(), "projects", "project-2");
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: store(), providers, runAgent: async () => {},
    launch: async (request) => { launches.push(request); throw new Error(`Cannot launch ${path}`); },
    checkoutChoices: async () => ({ nextPath, entries: [{ path, branch: "feature/one", available: true, dirty: false }] }),
  });
  const ui = await browser(panel);
  const checkout = ui.elements.get("checkout")!;
  const short = path.slice(homedir().length);
  assert.equal(checkout.children.find((item) => item.value === "existing:" + path)?.textContent, "project-1 (feature/one)");
  checkout.value = "new"; checkout.onchange!();
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "~" + nextPath.slice(homedir().length));
  checkout.value = "existing:" + path; checkout.onchange!();
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "~" + short);
  ui.elements.get("launch")!.onclick!(); await ui.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(launches[0]?.checkout)), { kind: "existing", path });
  assert.equal(ui.elements.get("error")!.textContent, `Cannot launch ~${short}`);
  panel.registration.dispose();
});

test("home abbreviation handles Git path separators and does not shorten similarly named directories", async () => {
  const home = homedir().replaceAll("\\", "/");
  const paths = [home + "/project", home + "-other/project"];
  if (process.platform === "win32") paths.push(home.toUpperCase() + "/project");
  const panel = await mount({ store: store(), providers, runAgent: async () => {}, launch: async () => {},
    checkoutChoices: async () => ({ error: `Unavailable: ${home}/missing`, entries: paths.map(path => ({ path, branch: "feature", available: true, dirty: false })) }),
  });
  const ui = await browser(panel);
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "Unavailable: ~/missing");
  const labels = ui.elements.get("checkout")!.children.slice(1).map(item => item.textContent);
  assert.equal(labels[0], "project (feature)");
  assert.equal(labels[1], "project (feature)");
  if (process.platform === "win32") assert.equal(labels[2], "project (feature)");
  panel.registration.dispose();
});

test("branch validation blocks existing and invalid branches inline and rechecks before launch", async () => {
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: store(), providers, runAgent: async () => {},
    checkoutChoices: async () => ({ nextPath: "/project-2", entries: [] }),
    validateBranch: async branch => branch === "existing" ? "Branch already exists." : branch.includes(" ") ? "Invalid branch name" : undefined,
    launch: async request => { launches.push(request); },
  });
  const ui = await browser(panel);
  const branch = ui.elements.get("branch")!;
  ui.elements.get("checkout")!.value = "new"; ui.elements.get("checkout")!.onchange!();
  for (const name of ["existing", "bad branch"]) {
    branch.value = name; branch.oninput!(); await ui.flush();
    assert.equal(ui.elements.get("launch")!.disabled, true);
    assert.equal(ui.elements.get("branchError")!.hidden, false);
    assert.equal(branch.attributes.get("aria-invalid"), "true");
  }
  branch.value = "existing"; branch.oninput!(); await ui.flush();
  assert.equal(ui.elements.get("branchError")!.textContent, "Branch already exists.");
  await panel.receive({ type: "launch", destination: "new", preset: store().preferredPreset, checkout: { kind: "new", branch: "existing" } });
  assert.equal(launches.length, 0);
  branch.value = "fresh"; branch.oninput!(); await ui.flush();
  assert.equal(ui.elements.get("branchError")!.hidden, true);
  assert.equal(ui.elements.get("launch")!.disabled, false);
  ui.elements.get("launch")!.onclick!(); await ui.flush();
  assert.equal(launches.length, 1);
  panel.registration.dispose();
});

test("checkout summaries show modified state while selectors omit paths, status and agent counts", async () => {
  const panel = await mount({ store: store(), providers, runAgent: async () => {}, launch: async () => {}, currentPath: "/project",
    checkoutChoices: async () => ({ nextPath: "/project-2", entries: [
      { path: "/project", branch: "main", available: true, dirty: true, agents: 5 },
      { path: "/project-1", branch: "feature", available: true, dirty: true, agents: 2 },
    ] }),
  });
  const ui = await browser(panel);
  const checkout = ui.elements.get("checkout")!;
  assert.deepEqual(checkout.children.map(item => item.textContent), ["project (main)", "New worktree…", "project-1 (feature)"]);
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "/project (modified)");
  checkout.value = "existing:/project-1"; checkout.onchange!();
  assert.equal(ui.elements.get("checkoutSummary")!.textContent, "/project-1 (modified)");
  assert.ok(panel.html.indexOf('id="checkoutSummary"') < panel.html.indexOf('for="branch"'));
  assert.ok(panel.html.includes("select,#branch{width:100%}"));
  assert.equal(panel.html.includes("A new window is recommended."), false);
  assert.ok(panel.html.includes("--vscode-editorWarning-foreground"));
  assert.equal(panel.html.includes("--vscode-errorForeground"), false);
  panel.registration.dispose();
});

test("layout creation always requests HEAD even from an older panel message", async () => {
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: store(), providers, runAgent: async () => {}, launch: async (request) => { launches.push(request); } });
  await panel.receive({ type: "launch", destination: "current", preset: store().preferredPreset, checkout: { kind: "new", branch: "feature", startPoint: "other", useExistingBranch: true } });
  assert.deepEqual(launches[0]?.checkout, { kind: "new", branch: "feature" });
  panel.registration.dispose();
});

test("missing and Auto Run-reserved worktrees are displayed but cannot launch a layout", async () => {
  const panel = await mount({ store: store(), providers, runAgent: async () => {}, launch: async () => {}, checkoutChoices: async () => ({ entries: [
    { path: "/missing", branch: "gone", available: false, dirty: false },
    { path: "/reserved", branch: "run", available: true, dirty: false, reserved: true },
  ] }) });
  const ui = await browser(panel);
  const checkout = ui.elements.get("checkout")!;
  for (const path of ["/missing", "/reserved"]) {
    checkout.value = "existing:" + path; checkout.onchange!();
    assert.equal(ui.elements.get("launch")!.disabled, true);
    assert.equal(checkout.children.find((item) => item.value === "existing:" + path)?.disabled, true);
  }
  panel.registration.dispose();
});


test("shrinking rows and columns immediately removes extra draft panes without recovery controls", async () => {
  const presets = store();
  const launches: LauncherRequest[] = [];
  const panel = await mount({ store: presets, providers, launch: async request => { launches.push(request); }, runAgent: async () => {} });
  const ui = await browser(panel);
  for (const id of ["shrink", "shrinkActions", "moveOverflow", "removeOverflow", "cancelShrink"]) assert.equal(ui.elements.has(id), false);
  const resize = (id: string, value: number) => { const input = ui.elements.get(id)!; input.value = String(value); input.onchange!(); };
  // Select the pane that will disappear, including its implicit empty terminal.
  resize("columns", 2);
  ui.elements.get("preview")!.children[3]!.onclick!();
  resize("rows", 1);
  assert.equal(Number(ui.elements.get("rows")!.value), 1);
  assert.equal(ui.elements.get("preview")!.children.length, 2);
  assert.equal(ui.elements.get("assignments")!.children.length, 1);
  assert.equal(ui.elements.get("launch")!.disabled, false);
  resize("columns", 1);
  assert.equal(ui.elements.get("preview")!.children.length, 1);
  // Repeated 1 -> 2 -> 1 transitions must remain usable.
  for (let i = 0; i < 3; i++) { resize("rows", 2); resize("rows", 1); }
  resize("rows", 10);
  assert.equal(Number(ui.elements.get("rows")!.value), 1, "invalid geometry keeps the last valid grid");
  resize("rows", 1);
  ui.elements.get("save")!.onclick!(); await ui.flush();
  assert.equal(presets.preferredPreset.rows, 1);
  assert.equal(presets.preferredPreset.columns, 1);
  assert.deepEqual(presets.preferredPreset.panes, [{ providers: ["chatgpt"] }]);
  ui.elements.get("launch")!.onclick!(); await ui.flush();
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.preset.panes.length, 1);
  panel.registration.dispose();
});

test("Run Agent reports launch warnings inline and remains available afterward", async () => {
  let runs = 0;
  const panel = await mount({ store: store(), providers, launch: async () => {}, runAgent: async warn => { runs++; warn("The agent could not start."); } });
  const ui = await browser(panel);
  ui.elements.get("run")!.onclick!(); await ui.flush();
  assert.equal(runs, 1);
  assert.equal(ui.elements.get("error")!.hidden, false);
  assert.equal(ui.elements.get("run")!.disabled, false);
  assert.equal(ui.elements.get("launch")!.disabled, false);
  panel.registration.dispose();
});
