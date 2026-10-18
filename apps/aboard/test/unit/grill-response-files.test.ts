import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GrillResponseFiles, grillResponseReference } from "../../src/grill/response-files.js";

for (const platform of ["win32", "linux"] as const) {
  test(`Grill references use each provider's file syntax on ${platform}`, () => {
    const path = platform === "win32" ? "C:\\Users\\A User\\responses.md" : "/home/a user/responses.md";
    assert.equal(grillResponseReference("claude", path, platform), platform === "win32"
      ? '@"C:/Users/A User/responses.md"' : '@"/home/a user/responses.md"');
    assert.equal(grillResponseReference("pi", path, platform), platform === "win32"
      ? '@"C:/Users/A User/responses.md"' : '@"/home/a user/responses.md"');
    assert.equal(grillResponseReference("chatgpt", path, platform), `"${path}"`);
  });
}

test("unquoted Windows Codex paths keep backslashes and have no mention prefix", () => {
  assert.equal(grillResponseReference("chatgpt", "C:/tmp/responses.md", "win32"), "C:\\tmp\\responses.md");
  assert.equal(grillResponseReference("pi", "C:\\tmp\\responses.md", "win32"), "@C:/tmp/responses.md");
});

test("response paths reject multiline input, terminal controls, and embedded quotes", () => {
  for (const path of ["/tmp/bad\npath.md", "/tmp/bad\rpath.md", '/tmp/bad"path.md', "/tmp/\u001bpath.md"]) {
    assert.throws(() => grillResponseReference("claude", path));
  }
});

test("response files preserve exact content, are unique, and survive a new store instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-grill-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new GrillResponseFiles(root);
  const contents = "Answers\r\n\r\n- First\n- Second\n```ts\nconst answer = 'é 😀';\n```\n";
  const first = await files.write(contents);
  const second = await new GrillResponseFiles(root).write("Next round");
  assert.notEqual(first, second);
  assert.equal(await readFile(first, "utf8"), contents);
  assert.equal(await readFile(second, "utf8"), "Next round");
  if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o600);
});

test("a subsequent write prunes only owned responses older than seven days", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aboard-grill-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new GrillResponseFiles(root);
  const expired = await files.write("Old round");
  const recent = await files.write("Current round");
  const unrelated = join(root, "unrelated.md");
  await writeFile(unrelated, "Not owned");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  await utimes(expired, old, old);
  await utimes(unrelated, old, old);
  await files.write("New round");
  await assert.rejects(readFile(expired), { code: "ENOENT" });
  assert.equal(await readFile(recent, "utf8"), "Current round");
  assert.equal(await readFile(unrelated, "utf8"), "Not owned");
  assert.equal((await readdir(root)).length, 3);
});
