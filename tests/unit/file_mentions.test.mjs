import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import register, { mentions, LIMITS } from "../../harness/productivity/file-mentions/pi/extension.ts";

const decode = (value) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function blocks(result, tag) {
  return [...result.text.matchAll(new RegExp(`<${tag} ([^>]+)>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => ({
    attributes: Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])),
    content: decode(match[2].slice(1, -1)),
  }));
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "file-mentions-unit-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const handlers = new Map();
  let transformer;
  register({
    on: (name, callback) => handlers.set(name, callback),
    registerMarkdownTransformer: (callback) => { transformer = callback; },
  });
  const notifications = [];
  return {
    cwd, notifications,
    end: (result, role = "user") => handlers.get("message_end")({ message: { role, content: [{ type: "text", text: result.text }] } }, { cwd, ui: { notify: (message, type) => notifications.push({ message, type }) } }),
    display: (result, messageType = "user") => transformer(result.text, { messageType }),
    input: (text, images, source = "interactive") => handlers.get("input")({ text, images, source }, { cwd }),
  };
}

test("recognizes quoted Pi completions, Windows paths and prose boundaries, not email or examples", () => {
  assert.deepEqual(mentions('Use @one @"two words" @\'three words\' (@src/file.ts) @C:\\work\\file.ts a@b.com x@no `@inline`\n```\n@fenced\n````\n~~~\n@also-fenced\n~~~\n@last'), ["one", "two words", "three words", "src/file.ts)", "C:\\work\\file.ts", "last"]);
  assert.deepEqual(mentions("Text\n```\n@unclosed"), []);
  assert.deepEqual(mentions('<skill name="x">@example</skill>\n<file-mentions><file>@nested</file></file-mentions> @real'), ["real"]);
});

for (const source of ["interactive", "rpc", "extension"]) {
  test(`loads text once per canonical path, retains images for ${source}`, async (t) => {
    const f = await fixture(t);
    const payload = '<file path="fake">& data</file>\n@not-recursive\n';
    await writeFile(join(f.cwd, "one.txt"), payload);
    await writeFile(join(f.cwd, "two words.txt"), "second");
    const images = [{ type: "image", mimeType: "image/png", data: "fixture" }];
    const result = await f.input('Explain @one.txt @./one.txt and @"two words.txt".', images, source);
    assert.equal(result.action, "transform");
    assert.equal(result.images, images);
    const files = blocks(result, "file");
    assert.deepEqual(files.map((b) => b.attributes.path), [join(f.cwd, "one.txt"), join(f.cwd, "two words.txt")]);
    assert.deepEqual(files.map((b) => b.content), [payload, "second"]);
    assert.equal((result.text.match(/<file-mentions source=/g) ?? []).length, 1);
    const visible = f.display(result);
    assert.equal(visible.includes(payload), false);
    assert.equal(visible.includes("<file-mentions"), false);
    assert.equal(/loaded\./.test(visible), false);
    assert.deepEqual(f.notifications, []);
    f.end(result);
    assert.deepEqual(f.notifications, [{ message: "one.txt loaded.\ntwo words.txt loaded.", type: "info" }]);
    f.display(result);
    f.end(result, "assistant");
    assert.equal(f.notifications.length, 1);
    assert.equal(f.display(result, "assistant"), result.text);
    // No session cache: a later input gets fresh bytes.
    await writeFile(join(f.cwd, "one.txt"), "changed");
    assert.equal(blocks(await f.input("@one.txt"), "file")[0].content, "changed");
  });
}

test("directory listings are shallow, bounded and explicit about truncation", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, "folder", "nested"), { recursive: true });
  for (let i = 0; i < LIMITS.directoryEntries + 5; i++) await writeFile(join(f.cwd, "folder", `file-${i}`), "not loaded");
  const result = await f.input("@folder");
  const [listing] = blocks(result, "directory");
  assert.equal(listing.attributes.path, join(f.cwd, "folder"));
  assert.equal(listing.attributes.truncated, "true");
  assert.equal(listing.attributes.entries, "100");
  assert.equal(listing.content.split("\n").length, 100);
  assert.equal(blocks(result, "file").length, 0);
  f.end(result);
  assert.deepEqual(f.notifications, [{ message: "folder loaded (listing truncated).", type: "info" }]);
});

test("empty folders and punctuation-ending filenames remain valid", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, "empty"));
  await writeFile(join(f.cwd, "file!"), "punctuation");
  const result = await f.input("@empty @file!");
  assert.equal(blocks(result, "directory")[0].attributes.entries, "0");
  assert.equal(blocks(result, "file")[0].content, "punctuation");
});

test("missing, binary, invalid UTF-8 and oversized files are explicit skips, not partial content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "binary"), Buffer.from([0, 1]));
  await writeFile(join(f.cwd, "invalid"), Buffer.from([0xff]));
  await writeFile(join(f.cwd, "large"), Buffer.alloc(LIMITS.fileBytes + 1, 65));
  const result = await f.input("@missing @binary @invalid @large");
  assert.equal(blocks(result, "file").length, 0);
  assert.equal([...result.text.matchAll(/<unavailable path=/g)].length, 4);
  f.end(result);
  assert.equal(f.notifications[0].message.split("\n").length, 4);
  assert.equal(f.notifications[0].type, "info");
  assert.equal(f.notifications[0].message.split("\n")[0], "missing not loaded.");
});

test("aggregate content and reference count are bounded", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await writeFile(join(f.cwd, `big-${i}`), Buffer.alloc(LIMITS.fileBytes, 65));
  const result = await f.input(Array.from({ length: 5 }, (_, i) => `@big-${i}`).join(" "));
  assert.equal(blocks(result, "file").length, 4);
  assert.equal([...result.text.matchAll(/<unavailable path=/g)].length, 1);
  const capped = await f.input(Array.from({ length: 25 }, (_, i) => `@missing-${i}`).join(" "));
  assert.equal([...capped.text.matchAll(/<unavailable path=/g)].length, 20);
  assert.equal(/<omitted count="5"/.test(capped.text), true);
});

test("absolute paths and aliases resolve without loading symlink targets twice", async (t) => {
  const f = await fixture(t);
  const path = resolve(f.cwd, "target");
  await writeFile(path, "target bytes");
  try { await symlink(path, join(f.cwd, "alias")); }
  catch (error) { if (error.code === "EPERM") { t.skip("symlink privilege unavailable"); return; } throw error; }
  assert.equal(blocks(await f.input(`@"${path}" @alias`), "file").length, 1);
});

test("ordinary messages and code examples leave input untouched", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.input("ordinary text `@example` a@b.com"), { action: "continue" });
  f.end({ text: "ordinary text" });
  assert.deepEqual(f.notifications, []);
});
