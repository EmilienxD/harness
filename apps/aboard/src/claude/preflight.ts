
import { DEFAULT_CLAUDE_COMMAND } from "./launch.js";
import type { CommandRunner, PreflightResult } from "../platform/preflight.js";

export interface ClaudeCommandProbeOptions {
  readonly run: CommandRunner;
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export class ClaudePreflightError extends Error {
  public constructor(public readonly reason: string) {
    super(`The configured Claude command cannot be run: ${reason}. Check .harness/config.json.`);
    this.name = "ClaudePreflightError";
  }
}

export class ClaudeCommandProbe {
  readonly #results = new Map<string, Promise<PreflightResult>>();

  public constructor(private readonly options: ClaudeCommandProbeOptions) {}

  public async verify(command: readonly string[] = DEFAULT_CLAUDE_COMMAND): Promise<PreflightResult> {
    const tokens = command.length === 0 ? DEFAULT_CLAUDE_COMMAND : command;
    const key = JSON.stringify(tokens);
    const cached = this.#results.get(key);
    if (cached !== undefined) return cached;
    const pending = this.#probe(tokens);
    this.#results.set(key, pending);
    // A probe that fails to run must not poison the cache forever: a user who
    // installs Claude and retries should get a fresh answer.
    void pending.then((result) => { if (!result.ok) this.#results.delete(key); });
    return pending;
  }

  /** Throwing wrapper for launch paths, which report failures as launch errors. */
  public async require(command?: readonly string[]): Promise<void> {
    const result = await this.verify(command);
    if (!result.ok) throw new ClaudePreflightError(result.reason);
  }

  public invalidate(): void {
    this.#results.clear();
  }

  async #probe(tokens: readonly string[]): Promise<PreflightResult> {
    const [program, ...fixed] = tokens;
    if (program === undefined) return { ok: false, reason: "the command is empty" };
    try {
      const execution = await this.options.run(program, [...fixed, "--version"], this.options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
      if (execution.code === 0) return { ok: true, version: firstLine(execution.stdout) };
      const detail = complaintLine(execution.stderr) || complaintLine(execution.stdout);
      return { ok: false, reason: `${program} exited with code ${execution.code ?? "unknown"}${detail === "" ? "" : ` (${detail})`}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "the command could not be started" };
    }
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function complaintLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const first = lines[0] ?? "";
  if (first === "Traceback (most recent call last):") return lines.at(-1) ?? first;
  return first;
}
