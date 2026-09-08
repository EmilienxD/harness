import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { SessionId } from "../domain/contracts.js";
import { buildCommandLine } from "../claude/shell.js";
import { DEFAULT_CHATGPT_COMMAND } from "./launch.js";

export interface ChatGptAppServerRequest {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ChatGptAppServerExchange = (request: ChatGptAppServerRequest) => Promise<unknown>;

export type ChatGptSessionAvailability =
  | { readonly state: "resumable" }
  | { readonly state: "missing" | "non-resumable"; readonly reason: string };

export class ChatGptSessionProbeError extends Error {
  public constructor(public readonly kind: "unreadable" | "probe-failed", detail: string) {
    super(kind === "unreadable"
      ? `Codex found the conversation but could not read its saved state (${detail}). The conversation may be corrupt.`
      : `Codex could not inspect saved conversations (${detail}). Check the configured ChatGPT command and Codex diagnostics.`);
    this.name = "ChatGptSessionProbeError";
  }
}

export class ChatGptSessionProbe {
  readonly #exchange: ChatGptAppServerExchange;

  public constructor(options: { readonly exchange?: ChatGptAppServerExchange; readonly timeoutMs?: number } = {}) {
    this.#exchange = options.exchange ?? ((request) => exchangeWithAppServer(request, options.timeoutMs));
  }

  public async inspect(
    sessionId: SessionId,
    cwd: string,
    command: readonly string[] = DEFAULT_CHATGPT_COMMAND,
  ): Promise<ChatGptSessionAvailability> {
    let result: unknown;
    try {
      result = await this.#exchange({
        command,
        cwd,
        method: "thread/read",
        params: { threadId: sessionId, includeTurns: false },
      });
    } catch (error) {
      const detail = rpcDetail(error);
      if (/\b(?:thread|conversation|session)\b.*\bnot found\b|\bnot found\b.*\b(?:thread|conversation|session)\b/iu.test(detail)) {
        return { state: "missing", reason: "Codex no longer has that saved conversation" };
      }
      if (/decode|deserialize|corrupt|rollout|invalid (?:thread|session)/iu.test(detail)) {
        throw new ChatGptSessionProbeError("unreadable", detail);
      }
      throw new ChatGptSessionProbeError("probe-failed", detail);
    }
    const thread = record(record(result).thread);
    if (thread.id !== sessionId) throw new ChatGptSessionProbeError("unreadable", "Codex returned a different conversation identity");
    if (thread.ephemeral === true) {
      return { state: "non-resumable", reason: "the Codex conversation was not persisted" };
    }
    const status = record(thread.status).type;
    if (status === "systemError") {
      return { state: "non-resumable", reason: "the saved Codex conversation is in a system-error state" };
    }
    return { state: "resumable" };
  }
}

async function exchangeWithAppServer(request: ChatGptAppServerRequest, timeoutMs = 15_000): Promise<unknown> {
  const [program, ...fixed] = request.command;
  if (program === undefined) throw new Error("the configured command is empty");
  return new Promise((resolve, reject) => {
    const appServerArguments = [...fixed, "app-server", "--listen", "stdio://"];
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? buildCommandLine("cmd", [program], appServerArguments) : program,
      windows ? [] : appServerArguments,
      {
        cwd: request.cwd,
        windowsHide: true,
        shell: windows,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let settled = false;
    let stderr = "";
    const finish = (error: unknown, value?: unknown, processClosed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      const complete = (): void => {
        if (error === undefined) resolve(value);
        else reject(error);
      };
      if (processClosed) complete();
      else {
        child.once("close", complete);
        child.kill();
      }
    };
    const send = (value: unknown): void => { child.stdin.write(`${JSON.stringify(value)}\n`); };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      let response: Record<string, unknown>;
      try { response = record(message); }
      catch (error) { finish(error); return; }
      if (response.id === 1) {
        if (response.error !== undefined) { finish(response.error); return; }
        send({ method: "initialized", params: {} });
        send({ method: request.method, id: 2, params: request.params });
      } else if (response.id === 2) {
        finish(response.error, response.result);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 2_000) stderr += chunk; });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled) finish(new Error(`app-server exited with code ${code ?? "unknown"}${stderr.trim() === "" ? "" : ` (${stderr.trim().split(/\r?\n/u)[0]})`}`), undefined, true);
    });
    const timer = setTimeout(() => finish(new Error(`app-server did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    timer.unref?.();
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "aboard", title: "Aboard", version: "0.0.0" } },
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChatGptSessionProbeError("unreadable", "Codex returned an invalid App Server response");
  }
  return value as Record<string, unknown>;
}

function rpcDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return "unknown App Server error";
}
