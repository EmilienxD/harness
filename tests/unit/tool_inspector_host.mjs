// Run with node tests/unit/tool_inspector_host.mjs <installed pi package directory>.
// Uses the real Pi loader, session registry and startup renderer; no inference.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = process.argv[2];
const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")));
sdk.initTheme("dark");
const require = createRequire(path.join(root, "package.json"));
const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { Type } = await import(pathToFileURL(require.resolve("typebox")));
const dir = await mkdtemp(path.join(tmpdir(), "tool-inspector-"));
const agentDir = path.join(dir, "agent");
await mkdir(agentDir);
await writeFile(path.join(dir, "AGENTS.md"), "Local test context.\n");
const settings = sdk.SettingsManager.inMemory({ quietStartup: false, defaultTools: ["+tool_search"] });
const loader = new sdk.DefaultResourceLoader({
  cwd: dir, agentDir, settingsManager: settings,
  additionalExtensionPaths: [path.resolve("harness/productivity/tool-inspector/pi/extension.ts")],
  extensionFactories: [sdk.createToolSearchExtension()],
  noSkills: true, noPromptTemplates: true, noThemes: true,
});
let session;
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: dir, agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(dir),
    customTools: [{
      name: "contract_probe", label: "Probe", description: "Returns a count without side effects.",
      parameters: Type.Object({ count: Type.Integer() }),
      outputSchema: Type.Object({ total: Type.Integer() }),
      execute: async () => { throw new Error("Inspection must not execute tools"); },
    }, {
      name: "deferred_probe", label: "Deferred probe", description: "Inspect deferred probe availability.",
      exposure: "deferred", parameters: Type.Object({}),
      execute: async () => { throw new Error("Inspection must not execute tools"); },
    }],
  }));
  await session.bindExtensions({ mode: "rpc" });
  let requests = 0;
  session.subscribe((event) => { if (event.type === "agent_start") requests++; });
  const host = Object.create(sdk.InteractiveMode.prototype);
  Object.defineProperty(host, "session", { get: () => session });
  Object.defineProperty(host, "settingsManager", { get: () => settings });
  Object.assign(host, {
    loadedResourcesContainer: new tui.Container(), options: {}, toolOutputExpanded: false,
    getBuiltInCommandConflictDiagnostics: () => [],
    buildScopeGroups: () => [], formatScopeGroups: () => "",
    getCompactExtensionLabels: () => ["tool-inspector"],
    formatContextPath: (p) => p, formatDisplayPath: (p) => p,
  });
  const render = () => host.loadedResourcesContainer.render(180).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  host.showLoadedResources();
  const initial = render();
  assert(initial.indexOf("[Context]") < initial.indexOf("[Tools]"));
  assert(initial.indexOf("[Tools]") < initial.indexOf("[Extensions]"));
  assert(initial.includes("contract_probe"));
  assert(initial.includes("read"));
  assert(initial.includes("deferred_probe (differed)"));
  assert(!initial.includes("contract_probe (differed)"));
  assert.equal((initial.match(/\[Tools\]/g) ?? []).length, 1);
  host.showLoadedResources();
  assert.equal((render().match(/\[Tools\]/g) ?? []).length, 1);
  const section = host.loadedResourcesContainer.children[3];
  section.setExpanded(true);
  assert(render().includes("Returns a count without side effects."));
  session.setActiveToolsByName(["read"]);
  assert(render().includes("contract_probe (not active)"));
  assert(render().includes("deferred_probe (not active)"));
  session.setActiveToolsByName(["read", "tool_search"]);
  assert(render().includes("deferred_probe (differed)"));
  assert(render().includes("contract_probe (not active)"));
  const search = session.getToolDefinition("tool_search");
  await search.execute("search-probe", { query: "deferred_probe" });
  assert(session.getActiveToolNames().includes("deferred_probe"));
  assert(!render().includes("deferred_probe (differed)"));
  settings.setQuietStartup(true);
  host.showLoadedResources();
  assert(!render().includes("[Tools]"));
  host.showLoadedResources({ force: true });
  assert(render().includes("[Tools]"));
  settings.setQuietStartup(false);
  const before = session.messages.length;
  await session.prompt("/tools contract_probe");
  const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "harness-tool-inspector:report");
  assert.equal(entries.length, 1);
  const report = entries[0].data.text;
  assert(report.includes("count: integer (required)"));
  assert(report.includes("total: integer (required)"));
  assert(!report.includes('"properties"'));
  assert(!report.includes('"type"'));
  assert(report.includes("not active"));
  const themeModule = await import(pathToFileURL(path.join(root, "dist/modes/interactive/theme/theme.js")));
  const entryRenderer = session.extensionRunner.getEntryRenderer("harness-tool-inspector:report");
  const component = entryRenderer(entries[0], { expanded: true }, themeModule.theme);
  const colored = component.render(80).join("\n");
  assert(colored.includes("\x1b["));
  assert(!report.includes("\x1b["));
  assert(colored.replace(/\x1b\[[0-9;]*m/g, "").includes("count: integer (required)"));
  await session.prompt("/tools");
  assert.equal(session.messages.length, before);
  assert.equal(requests, 0);
  // Rebinding the extension runtime must not stack the global presentation adapter.
  await session.reload();
  await session.bindExtensions({ mode: "rpc" });
  host.showLoadedResources();
  assert.equal((render().match(/\[Tools\]/g) ?? []).length, 1);
  console.log("PASS: real Pi registry, startup order, expansion, quiet/forced startup, inactive tools, schemas, reload, no inference or model-context pollution");
} finally {
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
