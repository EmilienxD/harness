import { DEFAULT_CHATGPT_COMMAND } from "./launch.js";
import type { CommandRunner, PreflightResult } from "../platform/preflight.js";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export class ChatGptPreflightError extends Error {
  public constructor(public readonly reason: string) {
    super(`The configured ChatGPT command cannot be run: ${reason}. Check .harness/config.json.`);
    this.name = "ChatGptPreflightError";
  }
}

export class ChatGptCommandProbe {
  readonly #results = new Map<string, Promise<PreflightResult>>();

  public constructor(private readonly options: { readonly run: CommandRunner; readonly timeoutMs?: number }) {}

  public async verify(command: readonly string[] = DEFAULT_CHATGPT_COMMAND): Promise<PreflightResult> {
    const tokens = command.length === 0 ? DEFAULT_CHATGPT_COMMAND : command;
    const key = JSON.stringify(tokens);
    const cached = this.#results.get(key);
    if (cached !== undefined) return cached;
    const pending = this.#probe(tokens);
    this.#results.set(key, pending);
    void pending.then((result) => { if (!result.ok) this.#results.delete(key); });
    return pending;
  }

  public async require(command?: readonly string[]): Promise<Extract<PreflightResult, { readonly ok: true }>> {
    const result = await this.verify(command);
    if (!result.ok) throw new ChatGptPreflightError(result.reason);
    return result;
  }

  async #probe(tokens: readonly string[]): Promise<PreflightResult> {
    const [program, ...fixed] = tokens;
    if (program === undefined) return { ok: false, reason: "the command is empty" };
    try {
      const execution = await this.options.run(program, [...fixed, "--version"], this.options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
      if (execution.code === 0) return { ok: true, version: execution.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "" };
      const detail = [...execution.stderr.split(/\r?\n/), ...execution.stdout.split(/\r?\n/)].map((line) => line.trim()).find(Boolean) ?? "";
      return { ok: false, reason: `${program} exited with code ${execution.code ?? "unknown"}${detail === "" ? "" : ` (${detail})`}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "the command could not be started" };
    }
  }
}

export function requirePermissionProfileVersion(version: string): void {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(version);
  const current = match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const supported = current !== undefined && (
    current[0] > 0
    || (current[0] === 0 && current[1] >= 138)
  );
  if (!supported) {
    throw new ChatGptPreflightError(
      `Codex 0.138.0 or later is required for Aboard's worktree permission profile; found ${version.trim() || "an unknown version"}`,
    );
  }
}
