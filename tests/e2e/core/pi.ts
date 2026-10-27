import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { containsPath, spawnableCommand } from "./path.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const PROVIDER = "harness-e2e";
const MODEL = "pi-e2e";

export type PiEvent = Readonly<Record<string, unknown>>;
export interface PiWorkspace {
  readonly projectRoot: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly env: NodeJS.ProcessEnv;
}
export interface PiRun {
  readonly status: "success" | "failed" | "aborted" | "handled";
  /** In-memory only: never print or persist these records. */
  readonly events: readonly PiEvent[];
  readonly eventTypes: readonly string[];
  readonly toolExecutions: readonly { readonly name: string; readonly isError: boolean }[];
  readonly assistantStopReasons: readonly string[];
}

/** Model configuration is agent-scoped; project settings select only this fake model. */
export async function preparePiWorkspace(root: string, baseUrl: string, token: string): Promise<PiWorkspace> {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/v1" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Pi E2E requires an authenticated loopback /v1 endpoint");
  }
  const projectRoot = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const sessionsDir = join(root, "sessions");
  const home = join(root, "home");
  for (const path of [join(projectRoot, ".pi"), agentDir, sessionsDir, home]) await mkdir(path, { recursive: true });
  await writeJson(join(agentDir, "auth.json"), {});
  await writeJson(join(agentDir, "models.json"), {
    providers: {
      [PROVIDER]: {
        baseUrl, api: "openai-responses", apiKey: "$HARNESS_E2E_PI_KEY",
        models: [{ id: MODEL, name: "Harness deterministic Pi E2E", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  });
  await writeJson(join(agentDir, "settings.json"), {
    cacheWarming: "off", transport: "sse", compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 15_000 } },
    extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"],
    packages: [], quietStartup: true,
  });
  await writeJson(join(projectRoot, ".pi", "settings.json"), {
    defaultProvider: PROVIDER, defaultModel: MODEL, defaultThinkingLevel: "off",
    defaultTools: ["read", "write", "edit"],
  });
  // Allowlist OS/runtime variables so even unknown inherited service credentials cannot leak.
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir", "programfiles", "programfiles(x86)", "programw6432", "lang", "lc_all", "term"]);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_IMAGE_PROTOCOL: "none",
    HARNESS_E2E_PI_KEY: token, HARNESS_STATE_DIR: join(root, "harness-state"),
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  });
  return { projectRoot, agentDir, sessionsDir, env };
}

export async function validatePiCli(workspace: PiWorkspace): Promise<string> {
  const version = await cliOutput(["--version"], workspace);
  // Accept stable 1.x releases from the integration baseline onward. Required flags
  // and real journeys check compatibility; a new minor version alone is not a failure.
  const release = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (!release || Number(release[1]) !== 1 || Number(release[2]) < 2) {
    throw new Error("Pi CLI >=1.2.0 and <2.0.0 (stable releases) is required by the deterministic E2E adapter");
  }
  const help = await cliOutput(["--help"], workspace);
  const required = ["--mode", "--offline", "--approve", "--session-dir", "--session-id", "--no-mcp"];
  if (required.some((flag) => !help.includes(flag))) throw new Error("Pi CLI protocol mismatch: required headless/isolation flags are missing");
  return version.trim();
}

export async function runPiJson(workspace: PiWorkspace, options: {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly timeoutMs?: number;
}): Promise<PiRun> {
  if (options.sessionId && options.sessionFile) throw new Error("Choose a Pi session ID or an exact saved session file");
  let savedFile: string | undefined;
  if (options.sessionFile) {
    try { savedFile = await realpath(resolve(options.sessionFile)); }
    catch { throw new Error("Pi E2E continuation requires an existing saved session file"); }
    if (!containsPath(await realpath(workspace.sessionsDir), savedFile)) throw new Error("Pi E2E refuses a session outside its owned session directory");
  }
  const session = savedFile ? ["--session", savedFile] : ["--session-id", options.sessionId ?? randomUUID()];
  const result = await capture([...baseArgs(workspace, "json"), ...session, "--", options.prompt], workspace, options.timeoutMs ?? TIMEOUT_MS);
  if (result.timedOut) throw new Error("Pi JSON journey exceeded its process deadline");
  const events = parseJsonLines(result.stdout);
  const summary = summarizePiRun(events);
  return result.code === 0 ? summary : { ...summary, status: "failed" };
}

/** Reads LF records continuously, including while a command awaits a response or settlement. */
export class PiRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #events: PiEvent[] = [];
  readonly #waiters = new Set<{ match: (event: PiEvent) => boolean; resolve: (event: PiEvent) => void; reject: (error: Error) => void }>();
  readonly #decoder = new StringDecoder("utf8");
  readonly #closed: Promise<void>;
  readonly #deadline: NodeJS.Timeout;
  #buffer = "";
  #bytes = 0;
  #sequence = 0;
  #failure: Error | undefined;
  #prompting = false;
  #closing: Promise<void> | undefined;

  constructor(workspace: PiWorkspace, options: { readonly sessionId?: string; readonly timeoutMs?: number; readonly model?: string; readonly thinkingLevel?: string } = {}) {
    if (options.model && !options.model.startsWith(`${PROVIDER}/`)) throw new Error("Pi fixture model overrides must use its fake provider");
    if (options.thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(options.thinkingLevel)) throw new Error("Invalid Pi fixture thinking level");
    const command = spawnableCommand("pi", [...baseArgs(workspace, "rpc"), "--session-id", options.sessionId ?? randomUUID(),
      ...(options.model ? ["--model", options.model] : []), ...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
    ]);
    this.#child = spawn(command.file, [...command.args], { cwd: workspace.projectRoot, env: workspace.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#bytes += chunk.length;
      if (this.#bytes > MAX_OUTPUT_BYTES) return this.#fail(new Error("Pi RPC exceeded the in-memory output limit"));
      this.#buffer += this.#decoder.write(chunk);
      let boundary: number;
      while ((boundary = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, boundary).replace(/\r$/u, "");
        this.#buffer = this.#buffer.slice(boundary + 1);
        if (line.length === 0) continue;
        try { this.#dispatch(parseRecord(line)); }
        catch { this.#fail(new Error("Pi RPC emitted an invalid JSONL record")); }
      }
    });
    // Consume stderr without retaining potentially sensitive diagnostics.
    this.#child.stderr.resume();
    this.#child.stdin.on("error", () => this.#fail(new Error("Pi RPC stdin closed before submission")));
    this.#child.once("error", () => this.#fail(new Error("Pi RPC could not start the real CLI")));
    this.#closed = new Promise((resolve) => this.#child.once("close", () => {
      clearTimeout(this.#deadline);
      this.#failure ??= new Error("Pi RPC process exited before the expected record");
      for (const waiter of this.#waiters) waiter.reject(this.#failure);
      this.#waiters.clear();
      resolve();
    }));
    this.#deadline = setTimeout(() => this.#fail(new Error("Pi RPC exceeded its process deadline")), options.timeoutMs ?? TIMEOUT_MS);
  }

  async request(type: string, fields: Readonly<Record<string, unknown>> = {}, timeoutMs = 15_000): Promise<PiEvent> {
    if (this.#failure) throw this.#failure;
    const id = `harness-rpc-${++this.#sequence}`;
    const response = this.#waitFor((event) => event.type === "response" && event.id === id, this.#events.length, timeoutMs);
    this.#child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`);
    return response;
  }

  async prompt(message: string, timeoutMs = 30_000): Promise<PiRun> {
    if (this.#prompting) throw new Error("Use RPC steer/follow-up explicitly instead of concurrent prompts");
    this.#prompting = true;
    const start = this.#events.length;
    try {
      const response = await this.request("prompt", { message }, timeoutMs);
      if (response.success !== true) throw new Error("Pi RPC rejected the prompt before acceptance");
      const data = asRecord(response.data);
      if (data?.disposition === "handled") return summarizePiRun(this.#events.slice(start), true);
      if (data?.disposition !== "started" && data?.disposition !== "queued") throw new Error("Pi RPC prompt response has an unknown disposition");
      await this.#waitFor((event) => event.type === "agent_settled", start, timeoutMs);
      return summarizePiRun(this.#events.slice(start));
    } finally { this.#prompting = false; }
  }

  /** Position for waiting on records that an extension produces without a client command. */
  get eventCount(): number { return this.#events.length; }

  /** Summarize the next extension-started run that settles after `start`. */
  async nextRun(start: number, timeoutMs = 30_000): Promise<PiRun> {
    const begin = await this.#waitFor((event) => event.type === "agent_start", start, timeoutMs);
    const from = this.#events.indexOf(begin);
    await this.#waitFor((event) => event.type === "agent_settled", from, timeoutMs);
    return summarizePiRun(this.#events.slice(from));
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      if (!this.#child.stdin.destroyed) this.#child.stdin.end();
      const forced = setTimeout(() => { void terminate(this.#child); }, 2000);
      await this.#closed;
      clearTimeout(forced);
    })();
    return this.#closing;
  }

  #dispatch(event: PiEvent): void {
    this.#events.push(event);
    for (const waiter of [...this.#waiters]) if (waiter.match(event)) { this.#waiters.delete(waiter); waiter.resolve(event); }
  }

  #waitFor(match: (event: PiEvent) => boolean, start: number, timeoutMs: number): Promise<PiEvent> {
    if (this.#failure) return Promise.reject(this.#failure);
    const existing = this.#events.slice(start).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(waiter); reject(new Error("Pi RPC expected record exceeded its deadline")); }, timeoutMs);
      const waiter = { match, resolve: (event: PiEvent) => { clearTimeout(timer); resolve(event); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      this.#waiters.add(waiter);
    });
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters) waiter.reject(this.#failure);
    this.#waiters.clear();
    void terminate(this.#child);
  }
}

export function summarizePiRun(events: readonly PiEvent[], handled = false): PiRun {
  const messages = events.filter((event) => event.type === "message_end").map((event) => asRecord(event.message)).filter((message) => message?.role === "assistant");
  const reasons = messages.map((message) => typeof message?.stopReason === "string" ? message.stopReason : "unknown");
  const settled = events.filter((event) => event.type === "agent_settled").at(-1);
  const failed = events.some((event) => event.type === "extension_error" || (event.type === "auto_retry_end" && event.success === false)) || reasons.some((reason) => reason === "error" || reason === "unknown");
  const aborted = settled?.aborted === true || reasons.includes("aborted");
  const status = failed ? "failed" : aborted ? "aborted" : handled && !settled && reasons.length === 0 ? "handled" : settled?.aborted === false && reasons.at(-1) === "stop" ? "success" : "failed";
  return {
    status, events, eventTypes: events.map((event) => String(event.type)), assistantStopReasons: reasons,
    toolExecutions: events.filter((event) => event.type === "tool_execution_end").map((event) => ({ name: String(event.toolName), isError: event.isError === true })),
  };
}

function baseArgs(workspace: PiWorkspace, mode: "json" | "rpc"): string[] {
  return ["--mode", mode, "--offline", "--approve", "--no-mcp", "--no-prompt-templates", "--no-themes", "--session-dir", workspace.sessionsDir];
}

async function cliOutput(args: readonly string[], workspace: PiWorkspace): Promise<string> {
  const result = await capture(["--offline", "--no-extensions", "--no-skills", ...args], workspace, 15_000);
  if (result.code !== 0 || result.timedOut) throw new Error("Pi CLI compatibility preflight failed");
  return result.stdout;
}

async function capture(args: readonly string[], workspace: PiWorkspace, timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  const command = spawnableCommand("pi", args);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { cwd: workspace.projectRoot, env: workspace.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk); else { overflow = true; void terminate(child); } });
    child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; void terminate(child); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Pi E2E could not start the real CLI")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (overflow) reject(new Error("Pi JSON exceeded the in-memory output limit"));
      else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
    });
  });
}

async function terminate(child: { readonly pid?: number | undefined; kill: () => boolean }): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); } catch { child.kill(); }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
  }
}

function parseJsonLines(output: string): PiEvent[] {
  try { return output.split("\n").filter((line) => line.trim().length > 0).map(parseRecord); }
  catch { throw new Error("Pi JSON emitted an invalid JSONL record"); }
}

function parseRecord(line: string): PiEvent {
  const record = asRecord(JSON.parse(line) as unknown);
  if (!record || typeof record.type !== "string") throw new Error("Invalid Pi record shape");
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
