import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { startFakeAnthropicServer } from "../../core/anthropic-server.js";
import { parseAnthropicMessagesRequest } from "../../core/anthropic-protocol.js";
import { isolatedClaudeEnvironment, runClaude } from "../../core/claude.js";
import { prepareCodexHome, runCodex } from "../../core/codex.js";
import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import type { OpenAiResponsesRequest, OpenAiScenarioResponse } from "../../core/openai-server.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { isolatedCodexEnvironment } from "../issues/support.js";

const execute = promisify(execFile);
const origin = "http://localhost:8087";
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
function png(): Buffer {
  const chunk = (kind: string, body: Buffer): Buffer => {
    const bytes = Buffer.concat([Buffer.from(kind), body]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  };
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", Buffer.from("00000001000000010806000000", "hex")), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
async function api(path: string, body?: unknown, method = body ? "POST" : "GET", key?: string): Promise<any> {
  const response = await fetch(`${origin}/api/v1/${path}`, { method, redirect: "error", headers: { Authorization: "Bearer 1234", "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Local Grill ${method} returned ${response.status}`);
  return response.json();
}
async function findHelper(root: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "grill_images.py") return join(root, entry.name);
    if (entry.isDirectory()) { try { return await findHelper(join(root, entry.name)); } catch { /* Continue the owned install tree. */ } }
  }
  throw new Error("Installed helper missing");
}

/** Actual installation, publication, saved edit, immutable review and receiving CLI effects. */
export async function runGrillImages(platform: "claude" | "chatgpt" | "pi", route: "copy" | "aboard") {
  if (process.platform !== "win32") throw new Error("This acceptance currently certifies Windows PowerShell command delivery");
  let commands: string[] = [];
  const transition = (request: OpenAiResponsesRequest): OpenAiScenarioResponse => {
    const outputs = request.input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
    const index = outputs.length;
    if (index > commands.length) throw new Error("Unexpected receiving history");
    if (index === commands.length) return { scenario: "grill-images", checkpoint: "complete", output: { type: "message", id: "msg_grill_images", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Diagram received.", annotations: [] }] } };
    const id = `call_grill_images_${index}`;
    const command = commands[index]!;
    const output = platform === "pi"
      ? { type: "function_call" as const, id: `fc_${id}`, call_id: id, name: "powershell", arguments: JSON.stringify({ command }), status: "completed" as const }
      : request.codeMode
        ? { type: "custom_tool_call" as const, id: `ctc_${id}`, call_id: id, name: "exec", input: `const r = await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 2000 })}); text(r.output);`, status: "completed" as const }
        : { type: "function_call" as const, id: `fc_${id}`, call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: command, yield_time_ms: 10_000, max_output_tokens: 2000 }), status: "completed" as const };
    return { scenario: "grill-images", checkpoint: `command-${index}`, output };
  };
  const fixture = await createPiFixture({ scenarioCatalogHash: "grill-images-v1", transition });
  let anthropic: Awaited<ReturnType<typeof startFakeAnthropicServer>> | undefined;
  const session = `grill-images-${randomUUID()}`;
  try {
    const project = fixture.workspace.projectRoot;
    Object.assign(fixture.workspace.env, { HARNESS_GRILL_URL: origin, HARNESS_GRILL_CODE: "1234" });
    await runFixtureInstaller(fixture.workspace, "install", ["grill-me-in-cloud"], { platform, pinnedRuntimes: false });
    const helper = await findHelper(join(project, platform === "claude" ? ".claude" : platform === "chatgpt" ? ".codex" : ".pi"));
    const harness = await findHarnessRoot();
    const { prepareImages } = await import(pathToFileURL(join(harness, "apps/aboard/dist/grill-image-acceptance.js")).href);
    const publishScript = join(fixture.root, "publish.py");
    await writeFile(publishScript, `import sys,json\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(helper, ".."))})\nfrom grill_me_in_cloud_hook import InterviewRuntime\nr=InterviewRuntime.from_environment(project=Path.cwd())\ni=r.start(${JSON.stringify(platform)},${JSON.stringify(session)},Path.cwd())\ni.source.write_text(json.dumps({"questions":[{"id":"Q1","question":"Review diagram","explanation_html":'<figure data-grill-diagram="flow"><pre class="mermaid">flowchart LR\\n A[Start] --&gt; B[Finish]</pre><figcaption>Flow</figcaption></figure>',"recommendation":"A","options":[{"letter":"A","label":"Keep","detail":"Keep it"}]}]}),encoding="utf-8")\nprint(json.dumps(r.publish(${JSON.stringify(platform)},${JSON.stringify(session)},project=Path.cwd())))\n`);
    await execute("uv", ["run", "--offline", "--no-sync", "--project", harness, "python", publishScript], { cwd: project, env: fixture.workspace.env, windowsHide: true, timeout: 20_000 });
    const detail = await api(`sessions/${platform}/${session}`);
    const round = detail.rounds?.[0] ?? detail.session?.grill_rounds?.[0];
    // Resolve the public session response without depending on display strings.
    const roundId = round?.id ?? detail.round_ids?.[0];
    if (!roundId) throw new Error(`Session response has no round identity: ${Object.keys(detail).join(",")}`);
    const baseline = { elements: [{ id: "node", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }], appState: {}, files: {} };
    const scene = structuredClone(baseline); scene.elements[0]!.x = 80;
    const saved = await api(`rounds/${roundId}/scenes/Q1/flow`, { source: "flowchart LR\n A[Start] --> B[Finish]", baseline, scene, imageFallback: false, expected_revision: null }, "PUT");
    const bytes = png();
    await api(`rounds/${roundId}/scenes/Q1/flow/image`, { revision: saved.revision, png: bytes.toString("base64") });
    await api(`rounds/${roundId}/answers/Q1`, { selected_option: "A", note: "Reviewed image", state: "queued" }, "PUT");
    const preview = await api(`rounds/${roundId}/prompt-preview`, {});
    const { snapshot } = await api(`rounds/${roundId}/prompt-snapshots`, { snapshot_id: preview.snapshot_id, reason: route === "aboard" ? "aboard" : "copy", expected_prompt: preview.prompt, expected_diagram_revisions: preview.diagram_revisions });
    assert.equal(snapshot.id, preview.snapshot_id);
    assert.equal(snapshot.images.length, 1);
    const cache = join(fixture.workspace.env.HARNESS_STATE_DIR!, "grill", "image-cache");
    const path = join(cache, `${snapshot.images[0].sha256}.png`);
    const receipt = join(project, "received.json");
    let receivingPrompt = snapshot.prompt;
    if (route === "copy") {
      const invocation = snapshot.prompt.split("\n").at(-1)!;
      commands.push(`${invocation} > images.json`);
    } else {
      const prepared = await prepareImages(snapshot.prompt, snapshot.id, origin, "1234", AbortSignal.timeout(8000), cache);
      receivingPrompt = prepared;
      assert.equal(prepared.slice(snapshot.images[0].reference_start, snapshot.images[0].reference_start + JSON.stringify(path).length), JSON.stringify(path));
    }
    const verify = `if ((Get-FileHash -Algorithm SHA256 -LiteralPath ${quote(path)}).Hash.ToLowerInvariant() -ne ${quote(snapshot.images[0].sha256)}) { throw 'image verification failed' }; [IO.File]::WriteAllText(${quote(receipt)}, ${quote(JSON.stringify({ question_id: "Q1", diagram_id: "flow", sha256: snapshot.images[0].sha256 }))})`;
    commands.push(verify);
    let state;
    if (platform === "pi") {
      const settings = join(project, ".pi", "settings.json");
      const value = JSON.parse(await readFile(settings, "utf8")); value.defaultTools = ["read", "write", "powershell"];
      await writeFile(settings, JSON.stringify(value));
      const run = await fixture.runJson({ prompt: receivingPrompt });
      assert.equal(run.status, "success");
      state = fixture.assertions();
    } else if (platform === "chatgpt") {
      // Reuse the fixture's loopback endpoint while keeping an isolated native Codex home.
      const models = JSON.parse(await readFile(join(fixture.workspace.agentDir, "models.json"), "utf8"));
      const baseUrl = Object.values(models.providers)[0] as { baseUrl: string };
      const home = await prepareCodexHome({ root: fixture.root, baseUrl: baseUrl.baseUrl, trustedProjects: [project] });
      const env = isolatedCodexEnvironment(fixture.workspace.env, home, fixture.workspace.env.HARNESS_E2E_PI_KEY!, fixture.root);
      const run = await runCodex(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox", "--", receivingPrompt], project, env);
      assert.equal(run.code, 0, `${platform} receiving process failed (${["unexpected argument", "unrecognized", "invalid value", "Error loading", "config", "not found", "model", "API", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "requires a value"].filter((value) => run.stderr.includes(value)).join(", ")})`); assert.equal(run.timedOut, false);
      state = fixture.assertions();
    } else {
      const config = join(fixture.root, "claude-config"); await mkdir(config); await writeFile(join(config, "settings.json"), "{}");
      anthropic = await startFakeAnthropicServer({ repoRoot: project, scenarioCatalogHash: "grill-images-claude-v1", parseRequest: parseAnthropicMessagesRequest, transition: (request) => {
        const outputs = request.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_result");
        const index = outputs.length;
        if (outputs.some((item) => item.is_error)) throw new Error("Real receiving command failed");
        if (index > commands.length) throw new Error("Unexpected receiving history");
        return { scenario: "grill-images", checkpoint: index === commands.length ? "complete" : `command-${index}`, messageId: `msg_grill_images_${index}`, stopReason: index === commands.length ? "end_turn" : "tool_use", content: index === commands.length ? [{ type: "text", text: "Diagram received." }] : [{ type: "tool_use", id: `toolu_grill_images_${index}`, name: "Bash", input: { command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(commands[index]!, "utf16le").toString("base64")}` } }] };
      } });
      const env = isolatedClaudeEnvironment(fixture.workspace.env, { ANTHROPIC_BASE_URL: anthropic.baseUrl, ANTHROPIC_AUTH_TOKEN: anthropic.authToken, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1" });
      const run = await runClaude(["-p", "--output-format", "stream-json", "--verbose", "--tools", "Bash", "--allowedTools", "Bash", "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--", receivingPrompt], project, env);
      assert.equal(run.code, 0, `${platform} receiving process failed (${["unexpected argument", "unrecognized", "invalid value", "Error loading", "config", "not found", "model", "API", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "requires a value"].filter((value) => run.stderr.includes(value)).join(", ")})`); assert.equal(run.timedOut, false);
      state = anthropic.assertions();
    }
    assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { question_id: "Q1", diagram_id: "flow", sha256: createHash("sha256").update(bytes).digest("hex") });
    assert.deepEqual(await readFile(path), bytes);
    if (route === "copy") {
      const result = JSON.parse((await readFile(join(project, "images.json"))).toString("utf16le").replace(/^\uFEFF/u, ""));
      assert.equal(result.snapshot_id, snapshot.id); assert.equal(result.images[0].path, path);
    }
    assert.equal(state.unexpectedRequests, 0);
    assert.equal(state.inferenceRequests, commands.length + 1);
    return { platform, route, inferenceRequests: state.inferenceRequests, unexpectedRequests: state.unexpectedRequests, verifiedImages: 1 };
  } finally {
    await api(`sessions/${platform}/${session}`, undefined, "DELETE").catch(() => undefined);
    await anthropic?.close(); await fixture.close();
  }
}

if (require.main === module) {
  (async () => { for (const platform of ["claude", "chatgpt", "pi"] as const) for (const route of ["copy", "aboard"] as const) console.log(JSON.stringify(await runGrillImages(platform, route))); })().catch((error) => { console.error(error instanceof Error ? error.message : "Grill receiving acceptance failed"); process.exitCode = 1; });
}
