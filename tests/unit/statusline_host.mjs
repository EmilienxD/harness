// node tests/unit/statusline_host.mjs <installed Pi package directory>
// Real Pi loader/session binding and TUI, with a controllable footer data provider.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = process.argv[2];
const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")));
const require = createRequire(path.join(root, "package.json"));
const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const dir = await mkdtemp(path.join(tmpdir(), "statusline-"));
const cwd = path.join(dir, "demo");
const agentDir = path.join(dir, "agent");
await mkdir(cwd);
await mkdir(agentDir);
sdk.initTheme("dark", false);
const { theme } = await import(pathToFileURL(path.join(root, "dist/modes/interactive/theme/theme.js")));
const settings = sdk.SettingsManager.inMemory({ compaction: { reserveTokens: 350 } });
const loader = new sdk.DefaultResourceLoader({
  cwd, agentDir, settingsManager: settings,
  additionalExtensionPaths: [path.resolve("harness/productivity/statusline/pi/extension.ts")],
  noSkills: true, noPromptTemplates: true, noThemes: true,
});
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const render = () => component.render(160).map(strip);
let session;
let component;
let branch = "main";
let renders = 0;
const listeners = new Set();
const footerData = {
  getGitBranch: () => branch,
  onBranchChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
};
const uiContext = {
  setFooter(factory) {
    component?.dispose();
    component = factory?.({ requestRender() { renders++; } }, theme, footerData);
  },
};
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd, agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  }));
  let requests = 0;
  session.subscribe((event) => { if (event.type === "agent_start") requests++; });
  let tokens = 416;
  session.getContextUsage = () => ({ tokens, contextWindow: 1000, percent: null });
  session.agent.state.model = { ...session.model, id: "test-model", provider: "openai", reasoning: true };
  session.setThinkingLevel("high");
  const errors = [];
  await session.bindExtensions({ mode: "interactive", uiContext, onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  assert(component, "session_start must install a footer");
  assert.deepEqual(render(), ["demo (main)  openai test-model high  416/650/1k"]);
  assert(component.render(160)[0].includes("\x1b[31m(main)\x1b[39m"));
  for (const [value, code] of [[0, 32], [324, 32], [325, 34], [487, 34], [488, 33], [584, 33], [585, 31], [1000, 31]]) {
    tokens = value;
    const raw = component.render(160)[0];
    assert(raw.endsWith(`\x1b[${code}m${value === 1000 ? "1k" : value}\x1b[39m/650/1k`));
    assert(raw.startsWith("demo "), "project must have no color");
    assert(raw.includes("\x1b[39m  openai test-model high  "), "model/thinking must have no color");
  }
  tokens = 0;
  assert(render()[0].endsWith("0/650/1k"));
  for (const unknown of [null, undefined, NaN, Infinity, -1]) {
    tokens = unknown;
    assert(render()[0].endsWith("?/650/1k"));
    assert(!component.render(160)[0].split("high  ")[1].includes("\x1b["));
  }
  session.getContextUsage = () => undefined;
  session.agent.state.model = { ...session.model, contextWindow: 256000 };
  assert(render()[0].endsWith("?/256k/256k"));
  branch = "feature/live";
  for (const callback of listeners) callback();
  assert.equal(renders, 1);
  assert(render()[0].startsWith("demo (feature/live)"));
  assert(component.render(160)[0].includes(theme.fg("accent", "(feature/live)")));
  branch = "detached";
  assert(render()[0].startsWith("demo (detached)"));
  branch = null;
  session.agent.state.model = { ...session.model, id: "other-model", provider: "anthropic" };
  session.setThinkingLevel("off");
  assert.deepEqual(render(), ["demo  anthropic other-model off  ?/256k/256k"]);
  session.getContextUsage = () => ({ tokens: 250, contextWindow: 1000, percent: 25 });
  settings.applyOverrides({ compaction: { modelOverrides: { "anthropic/other-model": { reserveTokens: 200 } } } });
  assert(render()[0].endsWith("250/800/1k"));
  settings.setCompactionEnabled(false);
  assert(render()[0].endsWith("250/off/1k"));
  assert(component.render(160)[0].endsWith("\x1b[32m250\x1b[39m/off/1k"));
  settings.setCompactionEnabled(true);
  settings.applyOverrides({ compaction: { modelOverrides: { "anthropic/other-model": { reserveTokens: 1000 } } } });
  assert(render()[0].endsWith("250/0/1k"));
  assert(component.render(160)[0].endsWith("\x1b[31m250\x1b[39m/0/1k"));
  settings.applyOverrides({ compaction: { modelOverrides: { "anthropic/other-model": { reserveTokens: 56000 } } } });
  session.getContextUsage = () => ({ tokens: 125000, contextWindow: 256000, percent: null });
  assert.deepEqual(render(), ["demo  anthropic other-model off  125k/200k/256k"]);
  const layouts = [
    "demo  anthropic other-model off  125k/200k/256k",
    "demo  other-model off  125k/200k/256k",
    "demo  other-model  125k/200k/256k",
    "demo  125k/200k/256k",
    "demo",
  ];
  for (let i = 0; i < layouts.length; i++) {
    assert.equal(strip(component.render(layouts[i].length)[0]), layouts[i]);
    if (i + 1 < layouts.length) {
      assert.equal(strip(component.render(layouts[i].length - 1)[0]), layouts[i + 1]);
    }
  }
  for (const [value, expected] of [[0, "0"], [999, "999"], [1000, "1k"], [125499, "125k"], [125500, "126k"]]) {
    session.getContextUsage = () => ({ tokens: value, contextWindow: 256000, percent: null });
    assert(render()[0].endsWith(`${expected}/200k/256k`));
  }
  session.getContextUsage = () => undefined;
  session.agent.state.model = undefined;
  assert.deepEqual(render(), ["demo  no-provider no-model off  ?/?/?"]);
  branch = "\x1b[31m你好\x1b[0m\nbranch";
  assert(render()[0].startsWith("demo (你好branch)"));
  for (const width of [0, 1, 2, 10, 25]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert(tui.visibleWidth(lines[0]) <= width);
  }
  component.invalidate();
  component.dispose();
  assert.equal(listeners.size, 0);
  await session.reload();
  await session.bindExtensions({ mode: "interactive", uiContext, onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  assert.equal(listeners.size, 1, "reload must not accumulate branch listeners");
  assert.equal(requests, 0);
  assert.equal(session.messages.length, 0);
  console.log("PASS: Pi 1.2.0 loader and session binding; exact footer, live model/thinking/context, Git refresh, unknown usage, control characters, narrow widths, reload/disposal; zero inference");
} finally {
  component?.dispose();
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
