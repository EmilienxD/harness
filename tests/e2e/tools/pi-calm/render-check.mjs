// Exercise the installed Pi components and shipped extension in an isolated child.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

const [packageRoot, extensionPath] = process.argv.slice(2);
const fromDist = (relative) => import(pathToFileURL(join(packageRoot, "dist", relative)).href);
const pi = await fromDist("index.js");
const requirePi = createRequire(join(packageRoot, "package.json"));
const { Container, visibleWidth, stripTerminalSequences, wrapTextWithAnsi, truncateToWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { loadExtensions } = await fromDist("core/extensions/loader.js");
const { withBuiltInRenderers } = await fromDist("core/tools/renderers/index.js");
pi.initTheme("dark", false);

// Reproduce a live upgrade from 1.5: reload reuses the old prototype patch.
if (process.argv.includes("--legacy-renderer")) {
  const nativeRender = pi.ToolExecutionComponent.prototype.render;
  const legacy = {
    hidesShell: () => true, builtInDefinitions: new WeakSet(), builtInExecutors: new WeakSet(),
    latestCall: () => undefined, spinnerFrame: () => "⠴",
  };
  globalThis[Symbol.for("pi-calm:built-in-tool-shell-layout:pi-0.82.0")] = legacy;
  pi.ToolExecutionComponent.prototype.render = function (width) {
    legacy.requestRender = () => this.ui.requestRender();
    if (!legacy.hidesShell()) return nativeRender.call(this, width);
    const call = legacy.latestCall();
    if (!call || call.rowId !== this.toolCallId) return [];
    if (width < 7) return wrapTextWithAnsi(call.summary, width).map((line) => truncateToWidth(line, width));
    const edge = "─".repeat(width - 2);
    return ["", `╭${edge}╮`, ...wrapTextWithAnsi(call.summary, width - 6).map((line, index) =>
      `│ ${index === 0 ? legacy.spinnerFrame() : " "} ${truncateToWidth(line, width - 6, "", true)} │`), `╰${edge}╯`];
  };
}

let expanded = false;
let hiddenLabel;
let listeners = 0;
let redraws = 0;
const notices = [];
const ui = {
  setWidget() { assert.fail("Calm must retain the native running display without widgets"); },
  setWorkingVisible() { assert.fail("Calm must leave Pi's running indicator alone"); },
  setWorkingMessage() { assert.fail("Tool summaries belong in the chat, not above the input bar"); },
  setHiddenThinkingLabel(label) { hiddenLabel = label; },
  onTerminalInput() { listeners++; return () => { listeners--; }; },
  getToolsExpanded() { return expanded; },
  setToolsExpanded() { assert.fail("Calm must not toggle native expansion or emit its status messages"); },
  notify(message, type) { notices.push({ message, type }); },
};
async function emit(extension, name, fields = {}) {
  for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...fields }, { ui });
}
async function load() {
  const loaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  await emit(loaded.extensions[0], "session_start");
  return loaded.extensions[0];
}
let extension = await load();
assert.equal(hiddenLabel, "");
let now = 0;
mock.method(performance, "now", () => now);
mock.timers.enable({ apis: ["setTimeout"] });
const advance = (milliseconds) => { now += milliseconds; mock.timers.tick(milliseconds); };

function sessionFor(name, definition, source = "builtin", sdkOverride = false) {
  return Object.assign(Object.create(pi.AgentSession.prototype), {
    _toolDefinitions: new Map([[name, { definition }]]),
    _baseToolsOverride: sdkOverride ? { [name]: definition } : {},
    getAllTools: () => [{ name, sourceInfo: { source } }],
  });
}
function rowFor(name, definition, args, id = `check-${name}`) {
  // This is the actual merge performed by Pi 1.2's interactive view.
  const renderers = withBuiltInRenderers(name, definition);
  assert.notEqual(renderers, definition);
  assert.equal(renderers.execute, definition.execute);
  return new pi.ToolExecutionComponent(name, id, args, {}, renderers,
    { requestRender() { redraws++; } }, process.cwd());
}
const cases = [
  ["read", pi.createReadTool, { path: "calm-result.txt" }],
  ["bash", pi.createBashTool, { command: "echo fixture" }],
  ["powershell", pi.createPowerShellTool, { command: "Write-Output fixture" }],
  ["edit", pi.createEditTool, { path: "calm-result.txt" }],
  ["write", pi.createWriteTool, { path: "calm-result.txt", content: "fixture" }],
  ["grep", pi.createGrepTool, { pattern: "fixture", path: "." }],
  ["find", pi.createFindTool, { pattern: "*.txt", path: "." }],
  ["ls", pi.createLsTool, { path: "." }],
];
const rows = [];
for (const [name, factory, args] of cases) {
  const definition = factory(process.cwd());
  const session = sessionFor(name, definition);
  const row = rowFor(name, session.getToolDefinition(name), args);
  assert.equal(row.render(100).length, 0, `${name}: hide streaming call`);
  row.updateResult({ content: [{ type: "text", text: "fixture output" }], isError: false,
    details: name === "edit" ? { diff: "-1 before\n+1 after" } : undefined }, false);
  assert.equal(row.render(100).length, 0, `${name}: hide completed result`);
  row.setExpanded(true);
  assert.equal(row.render(100).length, 0, `${name}: hide expanded result`);
  rows.push(row);
}
for (const event of ["agent_start", "agent_end", "agent_settled"]) await emit(extension, event);

const callRows = new Map();
const chatContainer = new Container();
const factories = new Map(cases.map(([name, factory]) => [name, factory]));
let callNumber = 0;
const activeCallIds = new Set();
const completeCall = async (id, isError = false) => {
  await emit(extension, "tool_execution_end", { toolCallId: id, isError });
  activeCallIds.delete(id);
};
const startCall = async (toolName, args, fields = {}, allowReplacement = true) => {
  if (allowReplacement) {
    for (const id of activeCallIds) await completeCall(id);
    advance(3000);
  }
  const id = fields.toolCallId ?? `summary-${++callNumber}`;
  if (!fields.parentToolCallId) {
    const definition = factories.get(toolName)(process.cwd());
    const session = sessionFor(toolName, definition);
    callRows.set(id, rowFor(toolName, session.getToolDefinition(toolName), args, id));
    chatContainer.addChild(callRows.get(id));
  }
  await emit(extension, "tool_execution_start", { toolName, args, toolCallId: id, ...fields });
  activeCallIds.add(id);
  return callRows.get(id);
};
const chatLines = (width = 100) => chatContainer.render(width);
const assertBlock = (summary) => {
  const lines = chatLines().map(stripTerminalSequences);
  assert.ok(lines.length >= 4, "a chat block is visible");
  assert.match(lines[1], /^╭/);
  assert.equal(lines.filter((line) => line.startsWith("╭")).length, 1, "only one block is visible");
  const body = lines.slice(2, -1).map((line) => line.slice(4, -2).trimEnd()).join("\n");
  assert.ok(body.includes(summary), "the chat block contains the expected summary");
  assert.match(lines.at(-1), /^╰/);
};
await startCall("read", { path: "src/app.ts" });
assertBlock("read src/app.ts");
const firstSpinner = chatLines()[2].slice(2, 3);
assert.match(firstSpinner, /[⠴⠦⠧⠇⠏⠋⠙⠹⠸⠼]/);
const beforeAnimation = redraws;
advance(80);
assert.notEqual(chatLines()[2].slice(2, 3), firstSpinner, "the left-hand Braille character animates");
assert.ok(redraws > beforeAnimation, "animation requests a redraw without new tool events");
advance(10000);
assertBlock("read src/app.ts");
const readId = [...activeCallIds][0];
const writeRow = await startCall("write", { path: "src/next.ts", content: "private file contents" }, {}, false);
assertBlock("read src/app.ts");
advance(10000);
assertBlock("read src/app.ts");
await completeCall(readId);
assert.match(chatLines()[2], /\u001b\[32m•\u001b\[39m/, "success produces a green dot immediately");
const finishedAnimation = redraws;
advance(2999);
assertBlock("read src/app.ts");
assert.equal(redraws, finishedAnimation, "a completed call no longer animates");
advance(1);
assertBlock("write src/next.ts");
assert.ok(!chatLines().join("\n").includes("src/app.ts"), "the previous block disappears");
writeRow.updateResult({ content: [{ type: "text", text: "private tool output" }], isError: false }, false);
await completeCall([...activeCallIds][0]);
assertBlock("write src/next.ts");
assert.ok(!chatLines().join("\n").includes("private"), "contents and output stay hidden");
const beforeClear = redraws;
await emit(extension, "before_provider_request");
assertBlock("write src/next.ts");
advance(2999);
assertBlock("write src/next.ts");
advance(1);
assert.deepEqual(chatLines(), [], "the next model request clears the block after the three-second minimum");
assert.ok(redraws > beforeClear, "the display timer requests a chat redraw");
await startCall("edit", { path: "new.ts", oldText: "before", newText: "after" }, { toolCallId: "new" });
advance(2000);
await emit(extension, "message_update", { message: { role: "assistant", content: [
  { type: "toolCall", id: "old", name: "read", arguments: { path: "old.ts" } },
  { type: "toolCall", id: "new", name: "edit", arguments: { path: "streaming.ts", oldText: "before", newText: "after" } },
] } });
assertBlock("edit streaming.ts");
await startCall("bash", { command: "npm test\nsecond line\u001b" }, { toolCallId: "new/1", parentToolCallId: "new" }, false);
assertBlock("edit streaming.ts");
await completeCall("new");
advance(2999);
assertBlock("edit streaming.ts");
advance(1);
assertBlock("bash npm test\nsecond line");
await startCall("read", { path: "nested.ts" }, { toolCallId: "new/1/1", parentToolCallId: "new/1" });
assertBlock("read nested.ts");
await emit(extension, "agent_settled", { aborted: true });
assertBlock("read nested.ts");
const settledSpinner = chatLines()[2].slice(2, 3);
assert.match(chatLines()[2], /\u001b\[31m•\u001b\[39m/, "an interrupted call produces a red dot");
advance(80);
assert.equal(chatLines()[2].slice(2, 3), settledSpinner, "the spinner stops on completion while the block lingers");
advance(2920);
assert.deepEqual(chatLines(), [], "settlement clears the block after its minimum, including abort");
await startCall("powershell", { command: "Write-Output fixture" });
assertBlock("powershell Write-Output fixture");
await completeCall([...activeCallIds].at(-1), true);
assert.match(chatLines()[2], /\u001b\[31m•\u001b\[39m/, "a failed tool produces a red dot");
await startCall("grep", { pattern: "example", path: "src" });
assertBlock("grep example src");
await startCall("find", { pattern: "*.ts", path: "src" });
assertBlock("find *.ts src");
await startCall("read", { path: "skip.ts" }, {}, false);
await startCall("ls", { path: "latest" }, {}, false);
assertBlock("find *.ts src");
for (const id of activeCallIds) if (id !== [...activeCallIds].at(-1)) await completeCall(id);
advance(3000);
assertBlock("ls latest");
await startCall("read", { path: "completed-before-display.ts" }, {}, false);
await emit(extension, "agent_settled");
advance(2999);
assertBlock("ls latest");
advance(1);
assert.deepEqual(chatLines(), [], "settlement drops pending calls instead of replaying a backlog");
await startCall("read", { path: "slow.ts" });
advance(20000);
await emit(extension, "before_provider_request");
assertBlock("read slow.ts");
await completeCall([...activeCallIds].at(-1));
advance(2999);
assertBlock("read slow.ts");
advance(1);
assert.deepEqual(chatLines(), [], "a long-running call gets three full seconds after completion");
await startCall("read", { path: "long-" + "x".repeat(200) });
assert.ok(chatLines().length > 4, "long calls wrap across multiple rows");
assert.ok(!chatLines().join("").includes("…"), "wrapping does not truncate calls below the character cap");
for (const width of [1, 3, 4, 40, 100])
  assert.ok(chatLines(width).every((line) => visibleWidth(line) <= width), "the chat block fits narrow terminals");
await startCall("bash", { command: 'echo first\r\n\tprintf "second"\n\u001b[31mecho third\u001b[0m' });
assertBlock('bash echo first\n    printf "second"\necho third');
assert.ok(!chatLines().join("").includes("\u001b"), "command escape sequences stay out of the rendered block");
await startCall("read", { path: "x".repeat(1100) });
const capped = chatLines(1200).map(stripTerminalSequences).slice(2, -1).map((line) => line.slice(4, -2).trimEnd()).join("\n");
assert.equal(Array.from(capped).length, 350);
assert.ok(capped.endsWith("…"), "only the character limit adds an ellipsis");
await startCall("read", { path: "🙂".repeat(1100) });
const unicodeCapped = chatLines(3000).map(stripTerminalSequences).slice(2, -1).map((line) => line.slice(4, -2).trimEnd()).join("\n");
assert.equal(Array.from(unicodeCapped).length, 350, "the cap counts Unicode characters without splitting surrogate pairs");

const thinkingMessage = {
  role: "assistant", content: [{ type: "thinking", thinking: "fixture reasoning" }],
  api: "openai-responses", provider: "harness-e2e", model: "pi-e2e", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0,
};
const thinking = new pi.AssistantMessageComponent(thinkingMessage, true);
thinking.setHiddenThinkingLabel("");
assert.equal(thinking.render(100).length, 0, "collapsed thinking has no row");
thinking.setHideThinkingBlock(false);
const reasoningLines = thinking.render(100);
assert.ok(reasoningLines.length > 0, "Ctrl+T reveals reasoning");
assert.deepEqual(thinkingMessage.content, [{ type: "thinking", thinking: "fixture reasoning" }]);

const toggle = async () => {
  const before = notices.length;
  await extension.commands.get("calm").handler("", { ui });
  const enabled = readFileSync(join(process.env.PI_CODING_AGENT_DIR, "calm"), "utf8").trim() === "on";
  assert.equal(notices.length, before + 1);
  assert.deepEqual(notices.at(-1), { message: `calm mode: ${enabled ? "enabled" : "disabled"}`, type: "info" });
};
await toggle();
assert.equal(hiddenLabel, undefined);
await startCall("read", { path: "off.ts" });
assert.equal(expanded, false, "toggle preserves the user's expansion preference");
const nativeLines = rows.map((row) => {
  const lines = row.render(100);
  assert.ok(lines.length > 0, "/calm off restores native output");
  return lines;
});
await toggle();
assertBlock("read off.ts");
await emit(extension, "agent_settled");
advance(3000);
assert.deepEqual(chatLines(), []);
for (const row of rows) assert.equal(row.render(100).length, 0);

// Overrides have their own presentation and must not be mistaken for native tools.
for (const source of ["extension", "sdk"]) {
  const definition = { ...pi.createReadTool(process.cwd()), execute: async () => ({ content: [], details: {} }) };
  const session = sessionFor("read", definition, source);
  assert.ok(rowFor("read", session.getToolDefinition("read"), { path: "fixture" }).render(100).length > 0);
}
const sdkDefinition = pi.createReadTool(process.cwd());
const sdkSession = sessionFor("read", sdkDefinition, "builtin", true);
assert.ok(rowFor("read", sdkSession.getToolDefinition("read"), { path: "fixture" }).render(100).length > 0);
rows[0].imageComponents = [{ render: () => ["image remains visible"] }];
assert.deepEqual(rows[0].render(100), ["image remains visible"]);
rows[0].imageComponents = [];

await startCall("read", { path: "unloading.ts" });
await emit(extension, "session_shutdown");
assert.equal(listeners, 0);
advance(10000);
const afterShutdown = redraws;
advance(1000);
assert.equal(redraws, afterShutdown, "shutdown cancels display and animation timers");
rows.forEach((row, index) => assert.deepEqual(row.render(100), nativeLines[index], "unloading Calm restores native rows"));
mock.timers.reset();
mock.restoreAll();
const patch = globalThis[Symbol.for("pi-calm:built-in-tool-shell-layout:pi-0.82.0")];
const renderWrapper = pi.ToolExecutionComponent.prototype.render;
const staleRenderer = () => ["stale drawing code"];
patch.renderCurrent = staleRenderer;
extension = await load();
assert.notEqual(patch.renderCurrent, staleRenderer, "reload replaces drawing code, not just state getters");
assert.equal(pi.ToolExecutionComponent.prototype.render, renderWrapper, "reload does not stack prototype wrappers");
assert.equal(listeners, 1);
assert.deepEqual(chatLines(), [], "reload does not restore historical tool calls");
for (const row of rows) assert.equal(row.render(100).length, 0, "reload retains hiding for existing rows");
await toggle();
rows.forEach((row, index) => assert.deepEqual(row.render(100), nativeLines[index], "native output is restored exactly"));
await toggle();
assert.equal(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "calm"), "utf8"), "on\n");
await emit(extension, "session_shutdown");
assert.equal(listeners, 0);
