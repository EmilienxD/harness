// Real installed Pi SDK and Markdown integration, without inference or personal state.
// node tests/unit/polished_code_blocks_host.mjs <pi package directory> [extension entry]
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
  // Keep the real extension/renderer and loader; replace only the clipboard
  // boundary so acceptance checks never overwrite the developer's clipboard.
  const entry = path.resolve(process.argv[3] ?? "harness/productivity/polished-code-blocks/pi/extension.ts");
  const fixture = path.join(dir, "extension");
  await mkdir(fixture);
  const copied = [];
  let clipboardError;
  globalThis.__polishedCopy = async text => {
    if (clipboardError) throw clipboardError;
    copied.push(text);
  };
  await writeFile(path.join(fixture, "index.ts"), (await readFile(entry, "utf8"))
    .replace('import { copyToClipboard, getMarkdownTheme }', 'const copyToClipboard = globalThis.__polishedCopy;\nimport { getMarkdownTheme }'));
  await writeFile(path.join(fixture, "renderer.ts"), await readFile(path.join(path.dirname(entry), "renderer.ts")));
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager: settings,
    additionalExtensionPaths: [path.join(fixture, "index.ts")],
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
  const context = { hasUI: true, sessionManager: session.sessionManager, ui: {
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
  const copy = commands.find(command => command.name === "copy-block");
  assert(copy);
  await copy.handler("", context);
  assert.equal(copied.length, 0, "empty sessions do not write the clipboard");
  const longCommand = "uv run harness install " + "long-package-".repeat(15);
  const firstMessage = { role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 100, content: [{ type: "text", text:
    "```powershell\n" + longCommand + "\n```\n\n> ```python\n> def greet():\n> \treturn '宽字符'\n> ```" }] };
  const firstId = session.sessionManager.appendMessage(firstMessage);
  const secondMessage = { ...firstMessage, timestamp: 200, content: [
    { type: "text", text: "- Example:\n\n  ```sh\n  echo nested\n  ```" },
    { type: "text", text: "```text\nsame\n```" },
    { type: "text", text: "```text\nsame\n```" },
  ] };
  session.sessionManager.appendMessage(secondMessage);
  await copy.handler("", context);
  assert.equal(copied.at(-1), "same", `default selects the latest block: ${JSON.stringify(notices.at(-1))}`);
  await copy.handler("1", context);
  assert.equal(copied.at(-1), longCommand, "long commands retain one logical line");
  await copy.handler("2", context);
  assert.equal(copied.at(-1), "def greet():\n\treturn '宽字符'", "preserves real newlines, tabs and Unicode");
  await copy.handler("3", context);
  assert.equal(copied.at(-1), "echo nested", "nested list blocks are indexed");
  const numberedFirst = new sdk.AssistantMessageComponent(firstMessage);
  const numberedSecond = new sdk.AssistantMessageComponent(secondMessage);
  assert(clean(numberedFirst.render(80)).includes("powershell #1"));
  assert(clean(numberedFirst.render(80)).includes("python #2"));
  const numbered = clean(numberedSecond.render(80));
  for (const label of ["sh #3", "text #4", "text #5"]) assert(numbered.includes(label));
  assert(clean(numberedSecond.render(24)).includes("#5"), "resize does not renumber");
  const duplicate = { ...secondMessage, timestamp: 300 };
  session.sessionManager.appendMessage(duplicate);
  await copy.handler("", context);
  assert(clean(new sdk.AssistantMessageComponent(duplicate).render(80)).includes("text #8"),
    "identical replies have distinct session numbers");
  const writes = copied.length;
  for (const arg of ["0", "-1", "1.5", "no", "1 2", "99", "999999999999999999999"]) {
    await copy.handler(arg, context);
  }
  assert.equal(copied.length, writes, "invalid or missing numbers never write clipboard");
  clipboardError = new Error("fixture clipboard unavailable");
  await copy.handler("1", context);
  assert.equal(notices.at(-1)[1], "error");
  clipboardError = undefined;
  await command.handler("off", context);
  await copy.handler("1", context);
  assert.equal(copied.at(-1), longCommand, "copy works with frames disabled");
  await command.handler("on", context);
  session.sessionManager.branch(firstId);
  await session.extensionRunner.emit({ type: "session_tree", newLeafId: firstId, oldLeafId: null });
  await copy.handler("", context);
  assert.equal(copied.at(-1), "def greet():\n\treturn '宽字符'", "branch changes discard other-branch blocks");
  assert(clean(numberedFirst.render(80)).includes("powershell #1"));
  const streaming = { ...secondMessage, timestamp: 400,
    content: [{ type: "text", text: "```sh\necho streaming" }] };
  await session.extensionRunner.emit({ type: "message_update", message: streaming });
  assert(clean(new sdk.AssistantMessageComponent(streaming).render(80)).includes("sh #3"),
    "streaming blocks are numbered before persistence");
  streaming.content[0].text += "\n```";
  session.sessionManager.appendMessage(streaming);
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message: streaming });
  await copy.handler("", context);
  assert.equal(copied.at(-1), "echo streaming");
  await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
  assert(clean(new sdk.AssistantMessageComponent(streaming).render(80)).includes("sh #3"),
    "resume reconstructs numbers from stored messages");
  assert.equal(requests, 0, "copy never starts inference");
  const beforeReload = md.render(50);
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(md.render(50), beforeReload);
  console.log("PASS: real Pi loader, frames, wrapping, nesting, streaming, numbering, exact clipboard payloads, validation, branches, resize, toggles, preview, reload; zero inference (clipboard transport stubbed).");
} finally {
  delete globalThis.__polishedCopy;
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
}
