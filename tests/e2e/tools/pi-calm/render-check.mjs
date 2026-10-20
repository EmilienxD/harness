// Exercise the installed Pi components and shipped extension in an isolated child.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

const [packageRoot, extensionPath, webToolkitPath, backgroundShellPath] = process.argv.slice(2);
const fromDist = (relative) => import(pathToFileURL(join(packageRoot, "dist", relative)).href);
const pi = await fromDist("index.js");
const requirePi = createRequire(join(packageRoot, "package.json"));
const { Container, Text, visibleWidth, stripTerminalSequences, wrapTextWithAnsi, truncateToWidth } = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
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
const registryLookup = pi.AgentSession.prototype.getToolDefinition;
let extension = await load();
assert.equal(pi.AgentSession.prototype.getToolDefinition, registryLookup, "Calm does not patch tool lookup");
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
  if (cases.some(([builtin]) => builtin === name) && !name.startsWith("web_")) assert.notEqual(renderers, definition);
  assert.equal(renderers?.execute, definition?.execute);
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
// Load the real Web Toolkit definitions, not lookalikes carrying the marker.
const webToolkit = await loadExtensions([webToolkitPath], process.cwd());
assert.deepEqual(webToolkit.errors, []);
const webTools = webToolkit.extensions[0].tools;
for (const [name, args] of [
  ["web_search", { query: "Pi extension API" }],
  ["web_fetch", { url: "https://example.com/docs" }],
]) {
  cases.push([name, () => webTools.get(name).definition, args]);
}
const rows = [];
const backgroundShell = await loadExtensions([backgroundShellPath], process.cwd());
assert.deepEqual(backgroundShell.errors, []);
for (const [name, tool] of backgroundShell.extensions[0].tools) {
  if (name !== "bash" && name !== "powershell") continue;
  const definition = tool.definition;
  const args = { command: "echo fixture", run_in_background: true };
  const row = rowFor(name, sessionFor(name, definition, "extension").getToolDefinition(name), args);
  assert.deepEqual(row.render(100), [], `${name}: hide Background Shell call`);
  row.updateResult({ content: [{ type: "text", text: "private shell output" }], isError: false }, false);
  assert.deepEqual(row.render(100), [], `${name}: hide Background Shell result`);
  await emit(extension, "tool_execution_start", { toolName: name, args, toolCallId: `check-${name}` });
  assert.ok(row.render(100).join("\n").includes("echo fixture"), `${name}: display Background Shell summary`);
  await emit(extension, "session_start");
  rows.push(row);
  const unrelated = { ...definition, execute: async () => ({ content: [], details: {} }) };
  assert.deepEqual(rowFor(name, sessionFor(name, unrelated, "extension").getToolDefinition(name), args).render(100), [],
    "unmarked shell overrides are hidden too");
}
for (const [name, factory, args] of cases) {
  const definition = factory(process.cwd());
  const session = sessionFor(name, definition, name.startsWith("web_") ? "extension" : "builtin");
  const row = rowFor(name, session.getToolDefinition(name), args);
  assert.equal(row.render(100).length, 0, `${name}: hide streaming call`);
  row.updateResult({ content: [{ type: "text", text: "fixture output" }], isError: false,
    details: name === "edit" ? { diff: "-1 before\n+1 after" } : undefined }, false);
  assert.equal(row.render(100).length, 0, `${name}: hide completed result`);
  row.setExpanded(true);
  assert.equal(row.render(100).length, 0, `${name}: hide expanded result`);
  rows.push(row);
}
for (const renderShell of ["default", "self", undefined]) {
  const name = `custom_${renderShell ?? "unavailable"}`;
  const definition = renderShell ? {
    name, execute: async () => ({ content: [], details: {} }), renderShell,
    renderCall: () => new Text("custom call framing", 0, 0),
    renderResult: () => new Text("private custom result", 0, 0),
  } : undefined;
  const row = rowFor(name, definition, { path: "custom.ts" });
  assert.deepEqual(row.render(100), [], `${name}: hide custom or fallback call`);
  row.updateResult({ content: [{ type: "text", text: "private fallback output" }], isError: false }, false);
  row.setExpanded(true);
  assert.deepEqual(row.render(100), [], `${name}: hide expanded custom or fallback result`);
  await emit(extension, "tool_execution_start", { toolName: name, toolCallId: `check-${name}`, args: { path: "custom.ts" } });
  assert.ok(row.render(100).join("\n").includes(`${name} custom.ts`), "arbitrary tool gets a summary");
  await emit(extension, "session_start");
  rows.push(row);
}
assert.equal(pi.AgentSession.prototype.getToolDefinition, registryLookup, "tool lookup remains unchanged");
for (const event of ["agent_start", "agent_end", "agent_settled"]) await emit(extension, event);

// Regression: overlapping calls must each have their own visible block.
const parallelRows = ["parallel-a", "parallel-b"].map((id) =>
  rowFor("read", pi.createReadTool(process.cwd()), { path: `${id}.ts` }, id));
const parallelMessage = { role: "assistant", content: ["parallel-a", "parallel-b"].map((id) =>
  ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } })) };
await emit(extension, "message_update", { message: parallelMessage });
assert.equal(parallelRows.filter((row) => row.render(100).length > 0).length, 2,
  "all streamed calls have independent Calm blocks");
for (const id of ["parallel-a", "parallel-b"]) {
  await emit(extension, "tool_execution_start", { toolName: "read", toolCallId: id, args: { path: `${id}.ts` } });
}
assert.equal(parallelRows.filter((row) => row.render(100).length > 0).length, 2,
  "both overlapping calls have independent Calm blocks");
await emit(extension, "tool_execution_end", { toolCallId: "parallel-b", isError: true });
advance(1000);
await emit(extension, "tool_execution_end", { toolCallId: "parallel-a", isError: false });
await emit(extension, "before_provider_request");
await emit(extension, "agent_settled");
advance(1999);
assert.ok(parallelRows.every((row) => row.render(100).length > 0), "settlement preserves both completion holds");
advance(1);
assert.ok(parallelRows[0].render(100).length > 0);
assert.deepEqual(parallelRows[1].render(100), [], "the earlier completion expires first");
advance(999);
assert.ok(parallelRows[0].render(100).length > 0);
advance(1);
assert.deepEqual(parallelRows[0].render(100), [], "each call expires exactly three seconds after its own completion");
await emit(extension, "message_update", { message: parallelMessage });
assert.ok(parallelRows.every((row) => row.render(100).length === 0), "late streaming updates do not resurrect calls");
await emit(extension, "session_start");

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
    const session = sessionFor(toolName, definition, toolName.startsWith("web_") ? "extension" : "builtin");
    callRows.set(id, rowFor(toolName, session.getToolDefinition(toolName), args, id));
    chatContainer.addChild(callRows.get(id));
  }
  await emit(extension, "tool_execution_start", { toolName, args, toolCallId: id, ...fields });
  activeCallIds.add(id);
  return callRows.get(id);
};
const chatLines = (width = 100) => chatContainer.render(width);
const assertBlock = (summary, count = 1) => {
  const lines = chatLines().map(stripTerminalSequences);
  assert.ok(lines.length >= 4, "a chat block is visible");
  assert.match(lines[1], /^╭/);
  assert.equal(lines.filter((line) => line.startsWith("╭")).length, count, "each visible call has its own block");
  const body = lines.map((line) => line.slice(4, -2).trimEnd()).join("\n");
  assert.ok(body.includes(summary), "the chat blocks contain the expected summary");
  assert.match(lines.at(-1), /^╰/);
};
for (const [name, args, summary] of [
  ["web_search", { query: "Pi extension API" }, "web_search Pi extension API"],
  ["web_fetch", { url: "https://example.com/docs" }, "web_fetch https://example.com/docs"],
]) {
  const row = await startCall(name, args);
  assertBlock(summary);
  await completeCall([...activeCallIds].at(-1), true);
  assert.match(chatLines()[2], /\u001b\[31m•\u001b\[39m/);
  await emit(extension, "before_provider_request");
  advance(3000);
  assert.deepEqual(row.render(100), [], "completed web output leaves no row");
  // Unmarked same-named extensions are covered too.
  const other = { ...webTools.get(name).definition, execute: async () => ({ content: [], details: {} }) };
  const unrelated = rowFor(name, sessionFor(name, other, "extension").getToolDefinition(name), args);
  assert.deepEqual(unrelated.render(100), [], "unmarked same-named custom tools are hidden");
}
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
assertBlock("read src/app.ts", 2);
assertBlock("write src/next.ts", 2);
advance(10000);
assertBlock("read src/app.ts", 2);
await completeCall(readId);
assert.match(chatLines()[2], /\u001b\[32m•\u001b\[39m/, "success produces a green dot immediately");
const runningAnimation = redraws;
advance(2999);
assertBlock("read src/app.ts", 2);
assert.ok(redraws > runningAnimation, "other running calls keep animating");
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
assert.deepEqual(chatLines(), [], "the block expires three seconds after completion despite a new model request");
assert.ok(redraws > beforeClear, "the display timer requests a chat redraw");
await startCall("edit", { path: "new.ts", oldText: "before", newText: "after" }, { toolCallId: "new" });
advance(2000);
await emit(extension, "message_update", { message: { role: "assistant", content: [
  { type: "toolCall", id: "new", name: "edit", arguments: { path: "streaming.ts", oldText: "before", newText: "after" } },
] } });
assertBlock("edit streaming.ts");
await startCall("bash", { command: "npm test\nsecond line\u001b" }, { toolCallId: "new/1", parentToolCallId: "new" }, false);
assertBlock("edit streaming.ts", 2);
assertBlock("bash npm test\nsecond line", 2);
await completeCall("new");
advance(2999);
assertBlock("edit streaming.ts", 2);
advance(1);
assertBlock("bash npm test\nsecond line");
await startCall("read", { path: "nested.ts" }, { toolCallId: "new/1/1", parentToolCallId: "new/1" }, false);
assertBlock("read nested.ts", 2);
await emit(extension, "agent_settled", { aborted: true });
assertBlock("read nested.ts", 2);
const settledLines = chatLines();
assert.equal(settledLines.filter((line) => line.includes("\u001b[31m•\u001b[39m")).length, 2,
  "each interrupted nested call produces a red dot");
advance(80);
assert.deepEqual(chatLines(), settledLines, "all spinners stop on settlement");
advance(2920);
assert.deepEqual(chatLines(), [], "each settled call expires after three seconds");
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
assertBlock("find *.ts src", 3);
assertBlock("read skip.ts", 3);
assertBlock("ls latest", 3);
for (const id of activeCallIds) if (id !== [...activeCallIds].at(-1)) await completeCall(id);
advance(3000);
assertBlock("ls latest");
await startCall("read", { path: "completed-before-display.ts" }, {}, false);
await emit(extension, "agent_settled");
advance(2999);
assertBlock("ls latest", 2);
assertBlock("read completed-before-display.ts", 2);
advance(1);
assert.deepEqual(chatLines(), [], "all settled calls expire independently without a backlog");
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

// SDK and extension overrides are filtered without touching their definitions.
for (const source of ["extension", "sdk"]) {
  const definition = { ...pi.createReadTool(process.cwd()), execute: async () => ({ content: [], details: {} }) };
  const session = sessionFor("read", definition, source);
  assert.deepEqual(rowFor("read", session.getToolDefinition("read"), { path: "fixture" }).render(100), []);
}
const sdkDefinition = pi.createReadTool(process.cwd());
const sdkSession = sessionFor("read", sdkDefinition, "builtin", true);
assert.deepEqual(rowFor("read", sdkSession.getToolDefinition("read"), { path: "fixture" }).render(100), []);
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
