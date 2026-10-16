import assert from "node:assert/strict";
import test from "node:test";
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
    value = ""; textContent = ""; hidden = false; disabled = false;
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
  ui.elements.get("removeOverflow")!.onclick!();
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
  assert.deepEqual(calls, [[]]);
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
