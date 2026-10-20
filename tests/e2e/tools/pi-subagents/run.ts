import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { PiRpcClient, type PiRun } from "../../core/pi.js";
import { childMarker, parentMarker, REQUEST_FILE, roundPayload, subagentsScenario, type Route } from "./scenario.js";
import { startGrillBoard } from "../pi-grill/board.js";

const execFileAsync = promisify(execFile);
const RESULT = "harness-subagents-result";

export interface PiSubagentsResult {
  readonly inferenceRequests: number;
  readonly unexpectedRequests: number;
  readonly parentStatus: PiRun["status"];
  readonly parentFinal: string | undefined;
  readonly request: { readonly state: string; readonly mode: string; readonly provider: string; readonly reply: string; readonly acknowledged: boolean; readonly boundToNativeSession: boolean };
  readonly deliveredResults: number;
  readonly deliveryMatchesRequest: boolean;
  readonly childSessionSaved: boolean;
  readonly requestFilesRemaining: number;
  readonly previousReplyInferenceRequests?: number;
  readonly publishedRounds?: number;
  readonly requestedModel?: string;
  readonly requestedEffort?: string;
  readonly childModel?: string;
  readonly childThinkingLevel?: string;
}

const finalText = (run: PiRun) => {
  const message = run.events.filter((event) => event.type === "message_end").map((event) => event.message as Record<string, unknown>).filter((item) => item?.role === "assistant").at(-1);
  return Array.isArray(message?.content) ? message.content.filter((block: { type?: string }) => block.type === "text").map((block: { text?: string }) => block.text).join("") : undefined;
};

async function waitFor<T>(check: () => Promise<T | undefined>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Pi subagents journey timed out: ${label}`);
}

async function sessionEntries(sessionsDir: string, sessionId: string): Promise<Record<string, unknown>[] | undefined> {
  const file = (await readdir(sessionsDir)).find((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (!file) return undefined;
  return (await readFile(join(sessionsDir, file), "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Read durable runtime state structurally; reply text stays in memory. */
async function runtimeState(python: string, stateDir: string, parentId: string) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "rows = db.execute(\"SELECT r.state,r.mode,r.provider,r.reply,r.delivery_id,r.acknowledged_at IS NOT NULL,s.provider_session_id=s.id,s.id FROM requests r JOIN sessions s ON s.id=r.child_session_id\").fetchall()",
    "inbox = db.execute('SELECT inbox FROM session_delegation WHERE parent_session_id=?', (sys.argv[2],)).fetchone()",
    "print(json.dumps({'requests': rows, 'inbox': inbox[0] if inbox else None}))",
  ].join("\n");
  const { stdout } = await execFileAsync(python, ["-c", script, join(stateDir, "sessions.sqlite3"), parentId], { windowsHide: true, timeout: 15_000 });
  return JSON.parse(stdout) as { requests: [string, string, string, string, string, number, number, string][]; inbox: string | null };
}

export async function runPiSubagentsJourney(route: Route, options: {
  pinnedRuntimes?: boolean;
  fullStack?: boolean;
  explicitModel?: boolean;
  shellWrite?: boolean;
  failedWrite?: boolean;
  localBoard?: { origin: string; code: string };
} = {}): Promise<PiSubagentsResult> {
  if (options.localBoard && (!options.fullStack || new URL(options.localBoard.origin).origin !== options.localBoard.origin || new URL(options.localBoard.origin).hostname !== "127.0.0.1")) {
    throw new Error("Combined live acceptance requires a loopback board and the full extension stack");
  }
  const transport = options.fullStack && !options.localBoard ? await startGrillBoard() : undefined;
  const board = options.localBoard ?? transport;
  const fixture = await createPiFixture(subagentsScenario({ explicitModel: options.explicitModel ?? false, grilling: !!board, shellWrite: options.shellWrite ?? false, failedWrite: options.failedWrite ?? false })).catch(async (error) => { await transport?.close(); throw error; });
  const parentId = randomUUID();
  let child: PiRpcClient | undefined;
  try {
    const root = await findHarnessRoot();
    const { projectRoot: project, env, sessionsDir } = fixture.workspace;
    if (options.shellWrite) {
      const path = join(project, ".pi", "settings.json");
      const settings = JSON.parse(await readFile(path, "utf8"));
      settings.defaultTools.push(process.platform === "win32" ? "powershell" : "bash");
      await writeFile(path, JSON.stringify(settings));
    }
    const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    // Install a real isolated uv tool, optionally using the shipped source pin.
    Object.assign(env, { UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin, UV_PYTHON: python, UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1" });
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ""}`;
    const packages = ["subagents", ...(options.fullStack ? ["grill-me-in-cloud", "command-guard", "on-read-reminder", "on-edit-reminder", "no-new-documents", "prefer-fewer-comments", "mid-prompt-skills"] : [])];
    await runFixtureInstaller(fixture.workspace, "install", packages, { scope: "project", pinnedRuntimes: options.pinnedRuntimes ?? true });
    if (options.fullStack) {
      await runFixtureInstaller(fixture.workspace, "install", ["background-shell", "calm", "environment-context", "file-mentions", "slash-command-guard"], { scope: "user" });
      Object.assign(env, { HARNESS_GRILL_URL: board!.origin, HARNESS_GRILL_CODE: board!.code });
    }
    if (options.explicitModel) {
      const modelsPath = join(fixture.workspace.agentDir, "models.json");
      const models = JSON.parse(await readFile(modelsPath, "utf8"));
      const provider = Object.values(models.providers)[0] as { models: Record<string, unknown>[] };
      provider.models.push({ ...provider.models[0], id: "gpt-6.1-sol", reasoning: true });
      await writeFile(modelsPath, JSON.stringify(models));
    }
    await mkdir(join(project, ".harness"), { recursive: true });
    // Children use the same isolated, trusted Pi invocation; sessions and agent directory are inherited.
    await writeFile(join(project, ".harness", "config.json"), JSON.stringify({
      version: 1, providers: { pi: { command: ["pi", "--offline", "--approve", "--no-mcp", "--no-prompt-templates", "--no-themes"] } },
    }), { flag: "wx" });
    const captures = join(fixture.root, "terminals");
    const stateDir = env.HARNESS_STATE_DIR!;
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), JSON.stringify({
      version: 1,
      terminalCommand: [process.execPath, join(root, "tests", "e2e", "tools", "pi-subagents", "capture-terminal.mjs"), captures],
    }));

    const prompt = `/skill:${board ? "grill-me-in-cloud" : "work-with-agent"} ${parentMarker(route)}`;
    let parent: PiRun;
    let previousReplyInferenceRequests: number | undefined;
    if (route === "auto") {
      // A headless parent exits after settling, so it must wait for its child before settlement.
      parent = await fixture.runJson({ prompt, sessionId: parentId, timeoutMs: 180_000 });
    } else {
      const rpc = fixture.rpc({ sessionId: parentId, timeoutMs: 240_000 });
      const waiting = rpc.prompt(prompt, 120_000);
      // The visible-terminal stand-in hands over the launch; the child must start within startup verification.
      const specification = await waitFor(async () => {
        const files = await readdir(captures).catch(() => []);
        return files[0] ? JSON.parse(await readFile(join(captures, files[0]), "utf8")) as { environment: NodeJS.ProcessEnv; argv: string[] } : undefined;
      }, "interactive child launch", 60_000);
      const childId = specification.environment.HARNESS_SESSION_ID!;
      const launchOption = (name: string) => {
        const index = specification.argv.indexOf(name);
        return index >= 0 ? specification.argv[index + 1] : undefined;
      };
      const model = launchOption("--model");
      const thinkingLevel = launchOption("--thinking");
      child = new PiRpcClient({ ...fixture.workspace, env: specification.environment }, {
        sessionId: childId, timeoutMs: 180_000,
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      });
      const first = await waiting;
      assert.equal(first.status, "success", "the live parent's delegating turn failed");
      const start = rpc.eventCount;
      assert.equal((await child.prompt(`${childMarker(route)} Reply with your answer.`, 60_000)).status, "success");
      const before = fixture.assertions().inferenceRequests;
      assert.equal((await child.prompt("/skill:reply-to-agent-with-previous-message", 30_000)).status, "handled");
      previousReplyInferenceRequests = fixture.assertions().inferenceRequests - before;
      // The live parent is idle; the delivered result itself starts its next turn.
      parent = await rpc.nextRun(start, 60_000);
    }

    const state = await runtimeState(python, stateDir, parentId);
    const [row] = state.requests;
    assert.ok(row && state.requests.length === 1, `exactly one delegated request is recorded: ${JSON.stringify({ status: parent.status, tools: parent.toolExecutions, inference: fixture.assertions().inferenceRequests, unexpected: fixture.assertions().unexpectedRequests })}`);
    const [requestState, mode, provider, reply, deliveryId, acknowledged, bound, childId] = row;
    const entries = (await sessionEntries(sessionsDir, parentId)) ?? [];
    const delivered = entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESULT);
    const inbox = state.inbox;
    // An ended parent prunes its empty inbox, so a missing directory holds no request files.
    const remaining = inbox ? (await readdir(inbox).catch(() => [])).filter((name) => name.startsWith(REQUEST_FILE)).length : -1;
    const assertions = fixture.assertions();
    let publishedRounds: number | undefined;
    if (board) {
      const response = await fetch(`${board.origin}/api/v1/sessions/pi/${parentId}`, { headers: { Authorization: `Bearer ${board.code}` }, signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200);
      const detail = await response.json() as { rounds: { id: string }[] };
      publishedRounds = detail.rounds.length;
      const roundResponse = await fetch(`${board.origin}/api/v1/rounds/${detail.rounds[0]?.id}`, { headers: { Authorization: `Bearer ${board.code}` }, signal: AbortSignal.timeout(15_000) });
      assert.equal(roundResponse.status, 200);
      const round = await roundResponse.json() as { round: { payload: unknown } };
      assert.deepEqual(round.round.payload, roundPayload);
    }
    let requestedModel: string | undefined;
    let requestedEffort: string | undefined;
    if (options.explicitModel) {
      const result = await execFileAsync(python, ["-c", "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute('SELECT s.model,s.effort FROM sessions s JOIN requests r ON r.child_session_id=s.id').fetchone()))", join(stateDir, "sessions.sqlite3")], { windowsHide: true, timeout: 15_000 });
      [requestedModel, requestedEffort] = JSON.parse(result.stdout);
    }
    const childEntries = await sessionEntries(sessionsDir, childId);
    const childModel = childEntries?.filter(entry => entry.type === "model_change").at(-1)?.modelId;
    const childThinkingLevel = childEntries?.filter(entry => entry.type === "thinking_level_change").at(-1)?.thinkingLevel;
    return {
      ...(typeof childModel === "string" ? { childModel } : {}),
      ...(typeof childThinkingLevel === "string" ? { childThinkingLevel } : {}),
      ...(publishedRounds === undefined ? {} : { publishedRounds }),
      ...(requestedModel === undefined ? {} : { requestedModel }),
      ...(requestedEffort === undefined ? {} : { requestedEffort }),
      inferenceRequests: assertions.inferenceRequests,
      unexpectedRequests: assertions.unexpectedRequests,
      parentStatus: parent.status,
      parentFinal: finalText(parent),
      request: { state: requestState, mode, provider, reply, acknowledged: acknowledged === 1, boundToNativeSession: bound === 1 },
      deliveredResults: delivered.length,
      deliveryMatchesRequest: delivered.every((entry) => (entry.details as { deliveryId?: string } | undefined)?.deliveryId === deliveryId),
      childSessionSaved: childEntries !== undefined,
      requestFilesRemaining: remaining,
      ...(previousReplyInferenceRequests === undefined ? {} : { previousReplyInferenceRequests }),
    };
  } finally {
    await child?.close();
    try { await fixture.close(); } finally {
      try {
        if (options.localBoard) {
          const response = await fetch(`${options.localBoard.origin}/api/v1/sessions/pi/${parentId}`, { method: "DELETE", headers: { Authorization: `Bearer ${options.localBoard.code}` }, signal: AbortSignal.timeout(15_000) });
          assert.ok(response.ok || response.status === 404, "Owned combined-workflow board session cleanup failed");
        }
      } finally { await transport?.close(); }
    }
  }
}
