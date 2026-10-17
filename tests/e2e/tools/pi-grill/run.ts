import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createPiFixture } from "../../core/pi-fixture.js";
import { runFixtureInstaller } from "../../core/installer.js";
import { containsPath } from "../../core/path.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";
import { startGrillBoard } from "./board.js";

const marker = "[E2E:pi-grill]";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="teal"/></svg>';
const question = (id: string, html: string) => ({ id, question: "Fixture decision", explanation_html: html, recommendation: "A", options: [{ letter: "A", label: "Keep", detail: "Preserve fixture behavior" }, { letter: "B", label: "Change", detail: "Change fixture behavior" }] });
const contentText = (content: any): string => typeof content === "string" ? content : (content ?? []).map((block: any) => block.text ?? "").join("\n");

/** Exercise installed Pi against an older hosted service without writing any board data. */
export async function runPiGrillAdmission(origin: string, code: string) {
  const fixture = await createPiFixture({ scenarioCatalogHash: "pi-grill-admission-v1", transition: () => { throw new OpenAiProtocolError("$.input", "admission must prevent inference", "pi-grill-admission"); } });
  try {
    Object.assign(fixture.workspace.env, { HARNESS_GRILL_URL: origin, HARNESS_GRILL_CODE: code });
    await runFixtureInstaller(fixture.workspace, "install", ["grill-me-in-cloud"]);
    const run = await fixture.rpc().prompt("/grill-me-in-cloud fixture admission probe");
    assert.equal(run.status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 0);
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    await runFixtureInstaller(fixture.workspace, "uninstall", ["grill-me-in-cloud"]);
    return { version: fixture.version, hosted: new URL(origin).hostname, admission: "unsupported-service-stopped", inferenceRequests: 0 };
  } finally { await fixture.close(); }
}

export async function runPiGrill(options: { scope: "project" | "user"; mode?: "rpc" | "json"; origin?: string; code?: string; faults?: boolean }) {
  const board = options.origin ? undefined : await startGrillBoard();
  const origin = options.origin ?? board!.origin;
  const code = options.code ?? board!.code;
  const sessionId = randomUUID();
  let fixture: Awaited<ReturnType<typeof createPiFixture>>;
  const transition = (request: OpenAiResponsesRequest): OpenAiScenarioResponse => {
    const reject = (detail: string): never => { throw new OpenAiProtocolError("$.input", detail, "pi-grill"); };
    if (request.model !== "pi-e2e") reject("unknown model");
    // Route from the newest actual user input, ignoring additive package context.
    const users = request.input.filter((item) => item.role === "user" && (contentText(item.content).includes(marker) || contentText(item.content).startsWith("[harness-grill-delivery:")));
    const user = users.at(-1);
    if (!user) reject("unknown grilling route");
    const userText = contentText(user!.content);
    const start = request.input.indexOf(user!);
    const history = request.input.slice(start + 1);
    const calls = history.filter((item) => item.type === "function_call");
    const outputs = history.filter((item) => item.type === "function_call_output");
    if (calls.length !== outputs.length) reject("incomplete tool history");
    const answer = userText.startsWith("[harness-grill-delivery:");
    const invalid = userText.includes("[E2E:invalid-round]");
    let steps: Array<{ path: string; content: string }>;
    if (answer) {
      // Compile only queued answers; compare structured effect, not agent instruction text.
      const answers = userText.split("\n").slice(1).filter((line) => line.startsWith("- Q"));
      steps = [{ path: "cloud-answer.txt", content: answers.join("\n") + "\n" }];
    } else {
      const source = userText.split("\n").map((line) => line.trim()).find((line) => /[\\/]round-\d{3}\.json$/.test(line));
      if (!source || !containsPath(fixture.root, source) || containsPath(fixture.workspace.projectRoot, source)) reject("unsafe or missing reserved round source");
      const sequence = /round-(\d{3})\.json$/.exec(source!)![1];
      const asset = join(dirname(source!), "assets", `round-${sequence}`, "comparison.svg");
      steps = invalid ? [{ path: source!, content: JSON.stringify({ questions: [] }) }] : [
        { path: asset, content: svg },
        { path: source!, content: JSON.stringify({ questions: [question("Q1", `<p>Fixture comparison</p><img src="assets/round-${sequence}/comparison.svg" alt="Fixture comparison">`), question("Q2", "<p>Unanswered decision</p>")] }) },
      ];
    }
    for (let index = 0; index < calls.length; index++) {
      const step = steps[index];
      if (!step || calls[index]!.name !== "write" || calls[index]!.call_id !== `call_grill_${answer ? "answer" : invalid ? "invalid" : "round"}_${index}` || outputs[index]!.call_id !== calls[index]!.call_id) reject("unknown tool identity or order");
      const input = JSON.parse(String(calls[index]!.arguments));
      if (input.path !== step!.path || input.content !== step!.content) reject("unexpected fixture mutation");
    }
    const step = steps[outputs.length];
    if (!step) return { scenario: "pi-grill", checkpoint: answer ? "answer-accepted" : invalid ? "round-rejected" : "round-published", output: { type: "message", id: `msg_grill_${answer ? "answer" : invalid ? "invalid" : "round"}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] } };
    if (!request.tools.some((tool) => tool.name === "write")) reject("native write missing");
    return { scenario: "pi-grill", checkpoint: answer ? "answer-effect" : invalid ? "invalid-round-write" : outputs.length ? "round-write" : "asset-write", output: { type: "function_call", id: `fc_grill_${answer ? "answer" : invalid ? "invalid" : "round"}_${outputs.length}`, call_id: `call_grill_${answer ? "answer" : invalid ? "invalid" : "round"}_${outputs.length}`, name: "write", arguments: JSON.stringify(step), status: "completed" } };
  };
  fixture = await createPiFixture({ scenarioCatalogHash: "pi-grill-v1", transition }).catch(async (error) => { await board?.close(); throw error; });
  const api = async (path: string, method = "GET", body?: any): Promise<any> => {
    const response = await fetch(`${origin}/api/v1/${path}`, { method, headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Grill E2E API ${method} failed with HTTP ${response.status}`);
    return response.json();
  };
  const waitFor = async (check: () => Promise<boolean>, label: string, timeout = 25_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(`Pi grill E2E timed out: ${label}`);
  };
  try {
    Object.assign(fixture.workspace.env, { HARNESS_GRILL_URL: origin, HARNESS_GRILL_CODE: code });
    await runFixtureInstaller(fixture.workspace, "install", ["grill-me-in-cloud"], { scope: options.scope });
    const platform = options.scope === "project" ? join(fixture.workspace.projectRoot, ".pi") : fixture.workspace.agentDir;
    await access(join(platform, "extensions", "harness-grill-me-in-cloud", "index.ts"));
    const probe = join(fixture.workspace.projectRoot, ".pi", "extensions", "grill-lifecycle-test");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "index.ts"), `export default function(pi) {
      pi.registerCommand("e2e-grill-reload", { handler: async (_args, ctx) => { await ctx.reload(); } });
      pi.registerCommand("e2e-grill-name", { handler: () => pi.setSessionName("Harness Pi grill E2E") });
      pi.registerCommand("e2e-grill-tree", { handler: async (_args, ctx) => { const first = ctx.sessionManager.getEntries().find(e => e.type === "custom" && e.customType === "harness-grill-cloud-v1" && e.data.phase === "start"); await ctx.navigateTree(first.id, { summarize: false }); } });
      pi.registerCommand("e2e-grill-new", { handler: async (_args, ctx) => { await ctx.newSession(); } });
      pi.registerCommand("e2e-grill-fork", { handler: async (_args, ctx) => { const user = ctx.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user"); await ctx.fork(user.id, { position: "at" }); } });
    }`);
    const rpc = fixture.rpc({ sessionId, timeoutMs: 150_000 });
    assert.equal((await rpc.prompt("/e2e-grill-name")).status, "handled");
    if (options.faults && board) {
      board.setSupported(false);
      assert.equal((await rpc.prompt(`/skill:grill-me-in-cloud ${marker}`)).status, "handled");
      assert.equal(fixture.assertions().inferenceRequests, 0);
      board.setSupported(true);
      board.setOffline(true);
      assert.equal((await rpc.prompt(`/grill-me-in-cloud ${marker}`)).status, "handled");
      assert.equal(fixture.assertions().inferenceRequests, 0);
      board.setOffline(false);
      assert.equal((await rpc.prompt(`/grill-me-in-cloud ${marker} [E2E:invalid-round]`)).status, "success");
      assert.equal(fixture.assertions().inferenceRequests, 2);
      const absent = await fetch(`${origin}/api/v1/sessions/pi/${sessionId}`, { headers: { Authorization: `Bearer ${code}` } });
      assert.equal(absent.status, 404);
      board.setFailCommit(true);
      assert.equal((await rpc.prompt(`/grill-me-in-cloud ${marker} [E2E:queued-branch]`)).status, "success");
      assert.equal(fixture.assertions().inferenceRequests, 5);
      assert.equal((await rpc.prompt("/e2e-grill-reload")).status, "handled");
      board.setFailCommit(false);
      assert.equal((await rpc.prompt("/e2e-grill-reload")).status, "handled");
      const recovered = await api(`sessions/pi/${sessionId}`);
      assert.equal(recovered.rounds.length, 1);
      assert.equal(fixture.assertions().inferenceRequests, 5);
      // Queue another publication, then abandon its ancestry before the service returns.
      board.setFailCommit(true);
      assert.equal((await rpc.prompt(`/grill-me-in-cloud ${marker} [E2E:queued-branch]`)).status, "success");
      assert.equal(fixture.assertions().inferenceRequests, 8);
      board.setFailCommit(false);
      assert.equal((await rpc.prompt("/e2e-grill-tree")).status, "handled");
      assert.equal((await rpc.prompt("/e2e-grill-reload")).status, "handled");
      const abandoned = await api(`sessions/pi/${sessionId}`);
      assert.equal(abandoned.rounds.length, 1);
      assert.equal(fixture.assertions().inferenceRequests, 8);
    }
    const offset = options.faults && board ? 8 : 0;
    const run = options.mode === "json" ? await fixture.runJson({ sessionId, prompt: `/skill:grill-me-in-cloud ${marker}` }) : await rpc.prompt(`/grill-me-in-cloud ${marker}`);
    assert.equal(run.status, "success");
    assert.equal(fixture.assertions().inferenceRequests, 3 + offset);
    let detail = await api(`sessions/pi/${sessionId}`);
    assert.equal(detail.session.provider, "pi");
    if (options.mode !== "json") assert.equal(detail.session.display_title, "Harness Pi grill E2E");
    const roundId = detail.rounds[0].id;
    const { round } = await api(`rounds/${roundId}`);
    assert.equal(round.payload.questions.length, 2);
    const imagePath = /src="([^"]+)"/.exec(round.payload.questions[0].explanation_html)![1]!;
    const image = await fetch(`${origin}${imagePath}`, { headers: { Authorization: `Bearer ${code}` } });
    assert.equal(image.status, 200);
    assert.equal(await image.text(), svg);
    if (options.mode === "json") {
      // JSON exits after settlement; resume the exact saved native session in RPC for delivery.
      await rpc.close();
    }
    const receiver = options.mode === "json" ? fixture.rpc({ sessionId, timeoutMs: 120_000 }) : rpc;
    if (options.mode === "json") assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
    await waitFor(async () => Boolean((await api(`sessions/pi/${sessionId}`)).aboard), "presence");
    const rivalRpc = options.faults ? fixture.rpc({ sessionId, timeoutMs: 120_000 }) : undefined;
    if (rivalRpc) {
      assert.equal((await rivalRpc.request("get_state")).success, true);
      assert.equal(fixture.assertions().inferenceRequests, 3 + offset);
    }
    await api(`rounds/${roundId}/answers/Q1`, "PUT", { selected_option: "B", note: "Fixture choice", state: "queued" });
    await api(`rounds/${roundId}/answers/Q2`, "PUT", { selected_option: "A", note: null, state: "draft" });
    const preview = await api(`rounds/${roundId}/prompt-preview`, "POST", {});
    assert.equal(preview.prompt, "- Q1: B. Fixture choice");
    const { snapshot } = await api(`rounds/${roundId}/prompt-snapshots`, "POST", { reason: "aboard", expected_prompt: preview.prompt });
    if (options.faults && board) board.setFailAck(true);
    const { delivery } = await api(`prompt-snapshots/${snapshot.id}/deliveries`, "POST", {});
    assert.equal((await api(`prompt-snapshots/${snapshot.id}/deliveries`, "POST", {})).delivery.id, delivery.id);
    await waitFor(async () => { try { return await readFile(join(fixture.workspace.projectRoot, "cloud-answer.txt"), "utf8") === "- Q1: B. Fixture choice\n"; } catch { return false; } }, "answer filesystem effect");
    await waitFor(async () => fixture.assertions().inferenceRequests === 5 + offset, "answer settlement");
    await waitFor(async () => ((await receiver.request("get_state")).data as any)?.isStreaming === false, "native idle state");
    if (options.faults && board) {
      // While the first owner is disconnected, a second relay still cannot obtain its claimed answer.
      const rival = await api("aboard/sync", "POST", { instance_id: `e2e-rival-${randomUUID()}`, sessions: [{ provider: "pi", session_id: sessionId, active_round_id: roundId, accepting: true }], acknowledgements: [] });
      assert.equal(rival.deliveries.length, 0);
      await waitFor(async () => { const files = await import("node:fs/promises").then(({ readdir }) => readdir(join(fixture.workspace.env.HARNESS_STATE_DIR!, "grill", "pi-relay"))); return files.some((name) => name.endsWith(".json")); }, "durable journal");
      assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
      board.setFailAck(false);
    }
    await waitFor(async () => (await api(`deliveries/${delivery.id}`)).delivery.status === "submitted-to-terminal", "confirmed delivery");
    const state = (await receiver.request("get_state")).data as any;
    assert.equal(state.sessionId, sessionId);
    assert.ok(containsPath(fixture.workspace.sessionsDir, state.sessionFile));
    const persisted = (await readFile(state.sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const messages = persisted.filter((entry: any) => entry.type === "message" && entry.message.role === "user" && contentText(entry.message.content).startsWith(`[harness-grill-delivery:${delivery.id}]\n`));
    assert.equal(messages.length, 1);
    const receipt = persisted.find((entry: any) => entry.type === "custom" && entry.customType === "harness-grill-cloud-v1" && entry.data?.deliveryId === delivery.id);
    assert.equal(receipt?.data.userEntryId, messages[0].id);
    await rivalRpc?.close();
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    // A competing relay must not claim or submit an already confirmed answer.
    const competing = await api("aboard/sync", "POST", { instance_id: `e2e-competing-${randomUUID()}`, sessions: [{ provider: "pi", session_id: sessionId }], acknowledgements: [] });
    assert.equal(competing.deliveries.length, 0);
    assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    detail = await api(`sessions/pi/${sessionId}`);
    assert.equal(detail.rounds.length, options.faults && board ? 2 : 1);
    assert.equal((await receiver.prompt("/e2e-grill-fork")).status, "handled");
    const child = (await receiver.request("get_state")).data as any;
    assert.notEqual(child.sessionId, sessionId);
    assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    assert.equal((await receiver.request("switch_session", { sessionPath: state.sessionFile })).success, true);
    assert.equal((await receiver.prompt("/e2e-grill-tree")).status, "handled");
    assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    const disconnected = await api("pi/sync", "POST", { instance_id: `e2e-abandoned-${randomUUID()}`, sessions: [{ provider: "pi", session_id: sessionId, active_round_id: randomUUID(), accepting: true }], acknowledgements: [] });
    assert.equal(disconnected.deliveries.length, 0);
    assert.equal((await receiver.prompt("/grill-cloud-stop")).status, "handled");
    assert.equal((await receiver.prompt("/e2e-grill-reload")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    assert.equal((await receiver.prompt("/e2e-grill-new")).status, "handled");
    assert.equal(fixture.assertions().inferenceRequests, 5 + offset);
    await receiver.close();
    await runFixtureInstaller(fixture.workspace, "uninstall", ["grill-me-in-cloud"], { scope: options.scope });
    await assert.rejects(access(join(platform, "extensions", "harness-grill-me-in-cloud", "index.ts")));
    await assert.rejects(access(join(platform, "harness", "pi-transport", "transport.ts")));
    assert.equal(fixture.assertions().unexpectedRequests, 0);
    return { version: fixture.version, scope: options.scope, mode: options.mode ?? "rpc", inferenceRequests: 5 + offset, hosted: board ? "fault-fixture" : new URL(origin).hostname };
  } finally {
    await fixture.close();
    try {
      const cleanup = await fetch(`${origin}/api/v1/sessions/pi/${sessionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${code}` }, signal: AbortSignal.timeout(15_000) });
      if (!cleanup.ok && cleanup.status !== 404) throw new Error(`Grill E2E owned-session cleanup failed with HTTP ${cleanup.status}`);
    } finally { await board?.close(); }
  }
}
