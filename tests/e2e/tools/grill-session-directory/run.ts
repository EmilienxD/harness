import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexHome, runCodex, validateCodexCli } from "../../core/codex.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { OpenAiProtocolError, startFakeOpenAiServer } from "../../core/openai-server.js";
import { containsPath } from "../../core/path.js";
import { preparePiWorkspace } from "../../core/pi.js";
import { canonicalMkdtemp } from "../../core/temp.js";
import { isolatedCodexEnvironment } from "../issues/support.js";

const marker = "[E2E:grill-session-directory]";
const round = { questions: [{ id: "Q1", question: "Fixture decision", explanation_html: "<p>Fixture</p>",
  recommendation: "A", options: [{ letter: "A", label: "Keep", detail: "Keep" }, { letter: "B", label: "Change", detail: "Change" }] }] };

export async function runGrillSessionDirectoryJourney() {
  await validateCodexCli();
  const root = await canonicalMkdtemp(join(tmpdir(), "harness-grill-session-directory-"));
  const board = await startBoard();
  let inference: Awaited<ReturnType<typeof startFakeOpenAiServer>> | undefined;
  try {
    const workspace = await preparePiWorkspace(root, "http://127.0.0.1:1/v1", "unused-fixture-key");
    const project = workspace.projectRoot;
    const child = join(project, "client");
    await mkdir(join(child, ".harness"), { recursive: true });
    await runFixtureInstaller(workspace, "install", ["grill-me-in-cloud"], { platform: "chatgpt" });
    await writeFile(join(project, ".harness/config.local.json"), JSON.stringify({ version: 1, grill: { url: board.origin, code: board.code } }));
    await writeFile(join(child, ".harness/config.local.json"), JSON.stringify({ version: 1, grill: { url: "http://127.0.0.1:1", code: "0000" } }));
    const runtime = join(workspace.env.HARNESS_STATE_DIR!, "grill");
    const callId = "call_grill_session_directory";
    let source = "";
    inference = await startFakeOpenAiServer({ scenarioCatalogHash: createHash("sha256").update("grill-session-directory:v1").digest("hex"),
      transition: async request => {
        const calls = request.input.filter(item => item.type === "function_call" || item.type === "custom_tool_call");
        const results = request.input.filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output");
        if (calls.length !== results.length || calls.length > 1 ||
          (calls.length === 1 && (calls[0]!.call_id !== callId || results[0]!.call_id !== callId))) {
          throw new OpenAiProtocolError("$.input", "unexpected grill directory history", "grill-session-directory");
        }
        if (results.length === 0) {
          const files = await readdir(join(runtime, "sessions"));
          assert.equal(files.length, 1);
          const state = JSON.parse(await readFile(join(runtime, "sessions", files[0]!), "utf8"));
          source = join(state.directory, "round-001.json");
          assert.ok(containsPath(runtime, source));
          const encoded = Buffer.from(JSON.stringify(round)).toString("base64");
          const command = process.platform === "win32"
            ? `[System.IO.File]::WriteAllBytes('${source.replaceAll("'", "''")}', [System.Convert]::FromBase64String('${encoded}'))`
            : `node -e "require('node:fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))" '${source.replaceAll("'", "'\\''")}' ${encoded}`;
          const args = { cmd: command, workdir: child, yield_time_ms: 10_000, max_output_tokens: 1000 };
          return { scenario: "grill-session-directory", checkpoint: "write-round-in-child", output: request.codeMode
            ? { type: "custom_tool_call", id: "ctc_grill_directory", call_id: callId, name: "exec", status: "completed", input: `const r = await tools.exec_command(${JSON.stringify(args)}); text(JSON.stringify(r));` }
            : { type: "function_call", id: "fc_grill_directory", call_id: callId, name: "exec_command", status: "completed", arguments: JSON.stringify(args) } };
        }
        let authored: unknown;
        try { authored = JSON.parse(await readFile(source, "utf8")); }
        catch { throw new OpenAiProtocolError("$.input", `round source missing or invalid: prepares=${board.prepares}, commits=${board.commits}`, "grill-session-directory"); }
        assert.deepEqual(authored, round);
        if (board.prepares !== 1 || board.commits !== 1) throw new OpenAiProtocolError("$.input", `publication incomplete: prepares=${board.prepares}, commits=${board.commits}, rejected=${board.unexpectedRequests}`, "grill-session-directory");
        assert.deepEqual(board.publication?.payload, round);
        const identity = board.publication?.project as { name?: string; path?: string } | undefined;
        if (identity?.name !== "project" || identity.path !== project) throw new OpenAiProtocolError("$.input", `project identity mismatch: name=${identity?.name === "project"}, path=${identity?.path === project}`, "grill-session-directory");
        await assert.rejects(access(join(child, "round-001.json")));
        return { scenario: "grill-session-directory", checkpoint: "published-with-session-config", output: {
          type: "message", id: "msg_grill_directory_done", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }],
        } };
      } });
    const home = await prepareCodexHome({ root, baseUrl: inference.baseUrl, trustedProjects: [project], extraConfig: ["[features]", "hooks = true"] });
    const run = await runCodex(["exec", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "--sandbox", "danger-full-access", `$grill-me-in-cloud ${marker}`], project,
      isolatedCodexEnvironment(workspace.env, home, inference.authToken, root), 60_000);
    assert.equal(run.timedOut, false);
    assert.equal(run.code, 0, JSON.stringify(inference.assertions()));
    assert.equal(inference.assertions().inferenceRequests, 2);
    assert.equal(inference.assertions().unexpectedRequests, 0);
    assert.equal(board.unexpectedRequests, 0);
    assert.equal(board.prepares, 1);
    assert.equal(board.commits, 1);
    await runFixtureInstaller(workspace, "uninstall", ["grill-me-in-cloud"], { platform: "chatgpt" });
  } finally {
    await inference?.close();
    await board.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function startBoard() {
  const code = "2468";
  let origin = "";
  let publication: Record<string, unknown> | undefined;
  let prepares = 0, commits = 0, unexpectedRequests = 0;
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.authorization !== `Bearer ${code}`) throw new Error("invalid dummy board credential");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (request.method === "GET" && request.url?.startsWith("/api/v1/sessions/chatgpt/")) { reply(404, {}); return; }
      if (request.method === "POST" && request.url === "/api/v1/publications/prepare" && body.provider === "chatgpt" && request.headers["idempotency-key"]) {
        publication = body; prepares++;
        reply(200, { publication: { id: "fixture-publication", status: "prepared" }, upload_targets: [] }); return;
      }
      if (request.method === "POST" && request.url === "/api/v1/publications/fixture-publication/commit" && prepares === 1) {
        commits++; reply(200, { round_number: 1, url: origin }); return;
      }
      throw new Error("unexpected board route");
    } catch { unexpectedRequests++; reply(400, { error: { code: "fixture_rejected", message: "Unexpected board request" } }); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, code, get publication() { return publication; }, get prepares() { return prepares; }, get commits() { return commits; }, get unexpectedRequests() { return unexpectedRequests; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
