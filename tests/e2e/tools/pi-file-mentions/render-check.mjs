// Real Pi extension loader and user-message component; no inference or personal state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, extensionPath] = process.argv.slice(2);
const fromDist = (path) => import(pathToFileURL(join(packageRoot, "dist", path)).href);
const sdk = await fromDist("index.js");
const { UserMessageComponent } = await fromDist("modes/interactive/components/user-message.js");
const { loadExtensions } = await fromDist("core/extensions/loader.js");
const requirePi = createRequire(join(packageRoot, "package.json"));
const tui = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
sdk.initTheme("dark", false);
const cwd = process.cwd();
await mkdir(join(cwd, "render-fixture"), { recursive: true });
const file = join(cwd, "render-fixture", "file.txt");
const payload = "HIDDEN_FIXTURE_BYTES_<file>&_@not-recursive";
await writeFile(file, payload);
const loaded = await loadExtensions([extensionPath], cwd);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { cwd });
const input = 'fixture-user-request @render-fixture/file.txt @"render-fixture/missing.txt"';
const images = [{ type: "image", mimeType: "image/png", data: "fixture" }];
let transformed;
for (const handler of extension.handlers.get("input") ?? []) transformed = await handler({ text: input, images }, { cwd });
assert.equal(transformed.action, "transform");
assert.equal(transformed.images, images);
assert.ok(transformed.text.includes("HIDDEN_FIXTURE_BYTES_"), "provider context retains fixture content");
assert.equal(extension.markdownTransformer(transformed.text, { messageType: "assistant" }), transformed.text);
const clean = (lines) => lines.map(tui.stripTerminalSequences).join("\n");
const render = (text, transformer = extension.markdownTransformer, width = 120) => clean(new UserMessageComponent(text, sdk.getMarkdownTheme(), 1, [transformer]).render(width));
const visible = render(transformed.text);
assert.equal(visible, render(input), "the user block contains only the original request");
const notifications = [];
const context = { cwd, ui: { notify: (message, type) => notifications.push({ message, type }) } };
for (const handler of extension.handlers.get("message_end") ?? []) await handler({ message: { role: "user", content: [{ type: "text", text: transformed.text }] } }, context);
assert.deepEqual(notifications, [{ message: "render-fixture/file.txt loaded.\nrender-fixture/missing.txt not loaded.", type: "info" }]);
for (const width of [24, 60, 120]) {
  const output = render(transformed.text, extension.markdownTransformer, width);
  assert.ok(!output.includes("HIDDEN_FIXTURE_BYTES_"));
  assert.ok(!output.includes("<file-mentions"));
  assert.ok(!output.includes(cwd));
}
// Later input handlers (for example skill expansion) may append more context.
const followed = render(transformed.text + "\n\nfixture-later-extension-context");
assert.ok(!followed.includes("HIDDEN_FIXTURE_BYTES_"));
assert.ok(!followed.includes(" loaded."));
assert.ok(followed.includes("fixture-later-extension-context"));
// Old 1.0 snapshots become compact too; replay/reload only changes presentation.
const old = transformed.text.replace(' source="harness-file-mentions"', "");
assert.equal(render(old), render(input));
assert.ok(!render(old).includes("HIDDEN_FIXTURE_BYTES_"));
const reloaded = await loadExtensions([extensionPath], cwd);
assert.deepEqual(reloaded.errors, []);
for (const handler of reloaded.extensions[0].handlers.get("session_start") ?? []) await handler({ type: "session_start" }, { cwd });
assert.equal(render(transformed.text, reloaded.extensions[0].markdownTransformer), visible);
// HTML, backticks and Markdown punctuation in paths stay literal labels.
const odd = '<file-mentions source="harness-file-mentions"><file path="' + join(cwd, "render-fixture", "a`[x]&lt;b&gt;.txt") + '" bytes="0">\n\n</file></file-mentions>';
assert.equal(render("fixture\n\n" + odd), render("fixture"));
for (const handler of extension.handlers.get("message_end") ?? []) await handler({ message: { role: "user", content: [{ type: "text", text: "fixture\n\n" + odd }] } }, context);
assert.equal(notifications.at(-1).message, "render-fixture/a`[x]<b>.txt loaded.");
const count = notifications.length;
render(transformed.text);
for (const handler of extension.handlers.get("message_end") ?? []) await handler({ message: { role: "assistant", content: [{ type: "text", text: transformed.text }] } }, context);
assert.equal(notifications.length, count, "rendering/replay and assistant messages do not emit status");
