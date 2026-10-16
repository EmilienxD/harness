import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { findHarnessRoot, runFixtureInstaller } from "../../core/installer.js";
import { createPiFixture } from "../../core/pi-fixture.js";
import { PiRpcClient, type PiRun } from "../../core/pi.js";
import { childMarker, parentMarker, REQUEST_FILE, scenario, type Route } from "./scenario.js";

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

export async function runPiSubagentsJourney(route: Route): Promise<PiSubagentsResult> {
  const fixture = await createPiFixture(scenario);
  let child: PiRpcClient | undefined;
  try {
    const root = await findHarnessRoot();
    const { projectRoot: project, env, sessionsDir } = fixture.workspace;
    const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const bin = join(fixture.root, "uv-bin");
    await mkdir(bin);
    // The installer's --local mode installs this checkout's runtime as a real uv tool entry point.
    Object.assign(env, { UV_TOOL_DIR: join(fixture.root, "uv-tools"), UV_TOOL_BIN_DIR: bin, UV_PYTHON: python, UV_PYTHON_DOWNLOADS: "never", UV_NO_PROGRESS: "1" });
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ""}`;
    await runFixtureInstaller(fixture.workspace, "install", ["subagents"], { scope: "project" });
    await mkdir(join(project, ".harness"), { recursive: true });
    // Children use the same isolated, trusted Pi invocation; sessions and agent directory are inherited.
    await writeFile(join(project, ".harness", "config.json"), JSON.stringify({
      version: 1, providers: { pi: { command: ["pi", "--offline", "--approve", "--no-mcp", "--no-prompt-templates", "--no-themes"] } },
    }), { flag: "wx" });
    const captures = join(fixture.root, "terminals");
    const stateDir = env.HARNESS_STATE_DIR!;
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.json"), JSON.stringify({
      terminalCommand: [process.execPath, join(root, "tests", "e2e", "tools", "pi-subagents", "capture-terminal.mjs"), captures],
    }));

    const parentId = randomUUID();
    const prompt = `/skill:work-with-agent ${parentMarker(route)}`;
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
        return files[0] ? JSON.parse(await readFile(join(captures, files[0]), "utf8")) as { environment: NodeJS.ProcessEnv } : undefined;
      }, "interactive child launch", 60_000);
      const childId = specification.environment.HARNESS_SESSION_ID!;
      child = new PiRpcClient({ ...fixture.workspace, env: specification.environment }, { sessionId: childId, timeoutMs: 180_000 });
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
    assert.ok(row && state.requests.length === 1, "exactly one delegated request is recorded");
    const [requestState, mode, provider, reply, deliveryId, acknowledged, bound, childId] = row;
    const entries = (await sessionEntries(sessionsDir, parentId)) ?? [];
    const delivered = entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESULT);
    const inbox = state.inbox;
    // An ended parent prunes its empty inbox, so a missing directory holds no request files.
    const remaining = inbox ? (await readdir(inbox).catch(() => [])).filter((name) => name.startsWith(REQUEST_FILE)).length : -1;
    const assertions = fixture.assertions();
    return {
      inferenceRequests: assertions.inferenceRequests,
      unexpectedRequests: assertions.unexpectedRequests,
      parentStatus: parent.status,
      parentFinal: finalText(parent),
      request: { state: requestState, mode, provider, reply, acknowledged: acknowledged === 1, boundToNativeSession: bound === 1 },
      deliveredResults: delivered.length,
      deliveryMatchesRequest: delivered.every((entry) => (entry.details as { deliveryId?: string } | undefined)?.deliveryId === deliveryId),
      childSessionSaved: (await sessionEntries(sessionsDir, childId)) !== undefined,
      requestFilesRemaining: remaining,
      ...(previousReplyInferenceRequests === undefined ? {} : { previousReplyInferenceRequests }),
    };
  } finally {
    await child?.close();
    await fixture.close();
  }
}
