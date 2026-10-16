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
  let percent = 41.6;
  session.getContextUsage = () => ({ tokens: 416, contextWindow: 1000, percent });
  session.agent.state.model = { ...session.model, id: "test-model", provider: "openai", reasoning: true };
  session.setThinkingLevel("high");
  const errors = [];
  await session.bindExtensions({ mode: "interactive", uiContext, onError: (e) => errors.push(e) });
  assert.deepEqual(errors, []);
  assert(component, "session_start must install a footer");
  assert.deepEqual(render(), ["demo (main)  openai:test-model:high  c:42/65%"]);
  assert(component.render(160)[0].includes("\x1b[31m(main)\x1b[39m"));
  for (const [value, code] of [[0, 32], [32.49, 32], [32.5, 34], [48.74, 34], [48.75, 33], [58.49, 33], [58.5, 31], [100, 31]]) {
    percent = value;
    const raw = component.render(160)[0];
    assert(raw.includes(`c:\x1b[${code}m${Math.round(value)}/65%\x1b[39m`));
    assert(raw.startsWith("demo "), "project must have no color");
    assert(raw.includes("\x1b[39m  openai:test-model:high  c:"), "model/thinking must have no color");
  }
  percent = 0;
  assert(render()[0].endsWith("c:0/65%"));
  for (const unknown of [null, undefined, NaN, Infinity]) {
    percent = unknown;
    assert(render()[0].endsWith("c:?/65%"));
    assert(!component.render(160)[0].split("c:")[1].includes("\x1b["));
  }
  session.getContextUsage = () => undefined;
  assert(render()[0].endsWith("c:?/?%"));
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
  assert.deepEqual(render(), ["demo  anthropic:other-model:off  c:?/?%"]);
  session.getContextUsage = () => ({ tokens: 250, contextWindow: 1000, percent: 25 });
  settings.applyOverrides({ compaction: { modelOverrides: { "anthropic/other-model": { reserveTokens: 200 } } } });
  assert(render()[0].endsWith("c:25/80%"));
  settings.setCompactionEnabled(false);
  assert(render()[0].endsWith("c:25/off%"));
  settings.setCompactionEnabled(true);
  settings.applyOverrides({ compaction: { modelOverrides: { "anthropic/other-model": { reserveTokens: 1000 } } } });
  assert(render()[0].endsWith("c:25/0%"));
  session.getContextUsage = () => undefined;
  session.agent.state.model = undefined;
  assert.deepEqual(render(), ["demo  no-provider:no-model:off  c:?/?%"]);
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
