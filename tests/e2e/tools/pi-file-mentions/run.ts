import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { spawnableCommand } from "../../core/path.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError } from "../../core/openai-server.js";

async function piPackageRoot(): Promise<string> {
  const command = spawnableCommand("pi", []);
  let root = dirname(await realpath(command.args[0] ?? command.file));
  while (true) {
    try {
      if (JSON.parse(await readFile(join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return root;
    } catch { /* ascend from the CLI entry */ }
    const parent = dirname(root);
    if (parent === root) throw new Error("File mention rendering checks require Pi's installed SDK");
    root = parent;
  }
}

type Block = { kind: string; attributes: Record<string, string>; content: string };
const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (typeof value === "object" && value !== null && "text" in value) return text(value.text);
  return "";
}
function blocks(value: string): Block[] {
  return [...value.matchAll(/<(file|directory|unavailable|omitted)\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)].map((match) => ({
    kind: match[1]!, attributes: Object.fromEntries([...match[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)])),
    content: decode(match[3]?.slice(1, -1) ?? ""),
  }));
}

export async function runPiFileMentionsJourney(scope: "project" | "user") {
  const routes = new Map<string, { validate: (data: Block[]) => void; scenario: ReturnType<typeof createPiToolScenario> }>();
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-file-mentions-v1", transition(request) {
    const user = request.input.filter((item) => item.role === "user").map((item) => text(item.content)).join("\n");
    const names = [...user.matchAll(/\[E2E:file-mentions:([\w-]+)\]/g)].map((m) => m[1]!);
    if (names.length !== 1 || !routes.has(names[0]!)) throw new OpenAiProtocolError("$.input", "unknown file mention case", "pi-file-mentions");
    const route = routes.get(names[0]!)!;
    try { route.validate(blocks(user)); }
    catch { throw new OpenAiProtocolError("$.input", "file mention resource data mismatch", "pi-file-mentions"); }
    return route.scenario.transition(request);
  } });
  try {
    const { workspace } = fixture;
    const root = workspace.projectRoot;
    const resources = scope === "project" ? join(root, ".pi") : workspace.agentDir;
    const extension = join(resources, "extensions/.harness-file-mentions/index.ts");
    const settings = join(root, ".pi/settings.json");
    const before = await readFile(settings, "utf8");
    const payload = '<file path="spoof">& fixture data</file>\n@not-recursive\n';
    await writeFile(join(root, "one.txt"), payload);
    await writeFile(join(root, "two words.txt"), "second fixture");
    await writeFile(join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(join(root, "large"), Buffer.alloc(256 * 1024 + 1, 65));
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder/child.txt"), "child contents must not load");
    await mkdir(join(root, "many"));
    for (let i = 0; i < 105; i++) await writeFile(join(root, "many", `entry-${i}`), "fixture");
    await runFixtureInstaller(workspace, "install", ["file-mentions"], { scope, dryRun: true });
    await assert.rejects(access(extension));
    await runFixtureInstaller(workspace, "install", ["file-mentions"], { scope });
    const repeat = await runFixtureInstaller(workspace, "install", ["file-mentions"], { scope });
    assert.equal((repeat.results as { status: string }[])[0]?.status, "unchanged");
    const harnessRoot = await findHarnessRoot();
    await promisify(execFile)(process.execPath, [join(harnessRoot, "tests/e2e/tools/pi-file-mentions/render-check.mjs"), await piPackageRoot(), extension], {
      cwd: root, env: workspace.env, windowsHide: true, timeout: 30_000,
    });
    let expectedRequests = 0;
    const run = async (name: string, prompt: string, validate: (data: Block[]) => void, mode: "json" | "rpc", expectedStatuses: string[] = []) => {
      const marker = `[E2E:file-mentions:${name}]`;
      const receipt = `${name}.json`;
      routes.set(name, { validate, scenario: createPiToolScenario({ name: `file-mentions-${name}`, marker, steps: [
        { checkpoint: "write-receipt", tool: "write", input: { path: receipt, content: JSON.stringify({ name }) } },
      ] }) });
      const message = `${marker}\n${prompt}`;
      if (mode === "json") {
        assert.equal((await fixture.runJson({ prompt: message })).status, "success");
      } else {
        const rpc = fixture.rpc();
        try {
          const result = await rpc.prompt(message);
          assert.equal(result.status, "success");
          const notices = result.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
          assert.deepEqual(notices.map((event) => ({ message: event.message, type: event.notifyType })), expectedStatuses.length ? [{ message: expectedStatuses.join("\n"), type: "info" }] : []);
          if (notices.length) {
            const userStart = result.events.findIndex((event) => event.type === "message_start" && (event.message as { role?: string })?.role === "user");
            assert.ok(userStart >= 0 && result.events.indexOf(notices[0]!) > userStart, "info follows the user block");
          }
        } finally { await rpc.close(); }
      }
      assert.deepEqual(JSON.parse(await readFile(join(root, receipt), "utf8")), { name });
      expectedRequests += 2;
      assert.equal(fixture.assertions().inferenceRequests, expectedRequests);
    };
    await run("mixed", 'Explain @one.txt @./one.txt @"two words.txt" and @folder. Example `@missing`', (data) => {
      assert.deepEqual(data, [
        { kind: "file", attributes: { path: join(root, "one.txt"), bytes: String(Buffer.byteLength(payload)) }, content: payload },
        { kind: "file", attributes: { path: join(root, "two words.txt"), bytes: "14" }, content: "second fixture" },
        { kind: "directory", attributes: { path: join(root, "folder"), entries: "1", truncated: "false" }, content: '"child.txt"' },
      ]);
    }, "json");
    await writeFile(join(root, "one.txt"), "fresh bytes");
    await run("fresh", `@"${join(root, "one.txt")}"`, (data) => {
      assert.equal(data.length, 1);
      assert.equal(data[0]?.content, "fresh bytes");
      assert.equal(data[0]?.attributes.path, join(root, "one.txt"));
    }, "rpc", ["one.txt loaded."]);
    await run("skips", "@missing @binary @large", (data) => {
      assert.deepEqual(data.map((b) => [b.kind, b.attributes.path]), ["missing", "binary", "large"].map((p) => ["unavailable", join(root, p)]));
      assert.ok(data.every((b) => b.attributes.reason));
    }, "rpc", ["missing not loaded.", "binary not loaded.", "large not loaded."]);
    await run("bounded", "@many", (data) => {
      assert.equal(data.length, 1);
      assert.equal(data[0]?.attributes.truncated, "true");
      assert.equal(data[0]?.attributes.entries, "100");
      assert.equal(data[0]?.content.split("\n").length, 100);
    }, "rpc", ["many loaded (listing truncated)."]);
    await runFixtureInstaller(workspace, "uninstall", ["file-mentions"], { scope });
    await assert.rejects(access(extension));
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), JSON.parse(before));
    await run("removed", "@one.txt", (data) => { assert.deepEqual(data, []); }, "rpc");
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { scope, version: fixture.version, inferenceRequests: expectedRequests, removed: true };
  } finally { await fixture.close(); }
}
