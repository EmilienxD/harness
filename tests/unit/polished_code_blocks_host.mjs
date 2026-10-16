// Real installed Pi SDK and Markdown integration, without inference or personal state.
// node tests/unit/polished_code_blocks_host.mjs <pi package directory> [extension entry]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")));
const require = createRequire(path.join(root, "package.json"));
const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
sdk.initTheme("dark");
const dir = await mkdtemp(path.join(tmpdir(), "polished-code-blocks-"));
const agentDir = path.join(dir, "agent");
await mkdir(agentDir);
let session;
try {
  const settings = sdk.SettingsManager.inMemory({});
  const source = "Before\n\n```typescript\nconst answer = 42;\n```\n\nAfter";
  const md = new tui.Markdown(source, 0, 0, sdk.getMarkdownTheme());
  const stock = md.render(50);
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager: settings,
    additionalExtensionPaths: [path.resolve(process.argv[3] ?? "harness/productivity/polished-code-blocks/pi/extension.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: dir, agentDir, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(dir),
  }));
  await session.bindExtensions({ mode: "rpc" });
  const clean = (lines) => lines.map(tui.stripTerminalSequences).join("\n");
  const result = md.render(50);
  assert(clean(result).includes("╭ typescript "));
  assert(clean(result).includes("const answer = 42;"));
  assert(clean(result).includes("Before"));
  assert(clean(result).includes("After"));
  assert(!clean(result).includes("```"));
  assert(result.some(line => /\x1b\[/.test(line)), "preserves themed highlighting");
  const assistant = new sdk.AssistantMessageComponent({
    role: "assistant", content: [{ type: "text", text: source }],
    api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  });
  assert(clean(assistant.render(60)).includes("╭ typescript "), "native assistant uses the patched renderer");
  sdk.initTheme("light");
  const light = new tui.Markdown(source, 0, 0, sdk.getMarkdownTheme());
  assert(clean(light.render(50)).includes("╭ typescript "));
  assert.notDeepEqual(light.render(50), result, "colors follow the active theme");
  sdk.initTheme("dark");

  const fixtures = [
    "```text\ntest\n```",
    "```\n\n```",
    "~~~unknown\nunknown language\n~~~",
    "```python\ndef greet():\n    return 1\n```",
    "```text\n" + "a".repeat(160) + "\n宽字符 café 👩‍💻\n```",
    "> ```js\n> const a = 1;\n> ```",
    "- Example:\n\n  ```js\n  const a = 1;\n  ```",
    "```ts\nconst streaming = true;\n`",
    "```text\none\n```\n```text\ntwo\n```",
  ];
  for (const text of fixtures) {
    const component = new tui.Markdown(text, 0, 0, sdk.getMarkdownTheme());
    for (const width of [8, 16, 40, 80]) {
      for (const line of component.render(width)) {
        assert(tui.visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`);
      }
    }
    component.invalidate();
    assert(clean(component.render(40)).includes("╭"), "nested and streaming blocks receive frames");
  }
  // A live component's cached rendering must switch back exactly, and reload
  // must not stack adapters. Use the registered command through the real runner.
  const commands = session.extensionRunner.getRegisteredCommands();
  const command = commands.find(command => command.name === "code-blocks");
  assert(command);
  const notices = [];
  let preview;
  const context = { hasUI: true, ui: {
    setStatus() {}, notify: (...args) => notices.push(args),
    custom: async (factory) => {
      let closed = false;
      preview = factory({}, {}, {}, () => { closed = true; });
      assert(clean(preview.render(80)).includes("╭ text "));
      preview.handleInput("x");
      assert(closed);
    },
  } };
  let requests = 0;
  session.subscribe(event => { if (event.type === "agent_start") requests++; });
  await command.handler("off", context);
  assert.deepEqual(md.render(50), stock);
  await command.handler("on", context);
  assert(clean(md.render(50)).includes("╭ typescript "));
  await command.handler("demo", context);
  assert.equal(requests, 0);
  const plain = new tui.Markdown("A **bold** paragraph with `inline code`.", 0, 0, sdk.getMarkdownTheme());
  const plainEnabled = plain.render(50);
  await command.handler("off", context);
  assert.deepEqual(plain.render(50), plainEnabled, "non-code Markdown is unchanged");
  await command.handler("on", context);
  const beforeReload = md.render(50);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(md.render(50), beforeReload);
  console.log("PASS: real Pi loader, themed frames, wrapping, nesting, streaming, resize, cache toggles, preview, reload; zero inference.");
} finally {
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
