/**
 * Pre-launch check on the configured Claude command.
 *
 * aboard types its launch into a VS Code terminal it does not own, so it never
 * sees the command's exit status: a missing binary or a mistyped
 * `aboard.launch.claudeCommand` produces a shell error the extension cannot
 * read, and the launch looks alive until the startup proof gives up on it.
 * Running the same command with `--version` in a child process aboard *does*
 * own answers the question directly, before a terminal exists — no model call,
 * no session, no tokens.
 *
 * The probe verifies that the command runs, nothing more. Everything downstream
 * of that — a rejected flag, an auth wall, an unresumable session id — dies
 * with the CLI's own message in the terminal and is caught by the wrapper's
 * exit record instead.
 */

import { exec, execFile } from "node:child_process";

import { DEFAULT_CLAUDE_COMMAND } from "./launch.js";
import { buildCommandLine } from "./shell.js";

export interface CommandExecution {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  program: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandExecution>;

export type PreflightResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

export interface ClaudeCommandProbeOptions {
  readonly run: CommandRunner;
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export class ClaudePreflightError extends Error {
  public constructor(public readonly reason: string) {
    super(`The configured Claude command cannot be run: ${reason}. Check aboard.launch.claudeCommand.`);
    this.name = "ClaudePreflightError";
  }
}

/**
 * Caches per command, so only the first launch after a configuration change
 * pays for the probe. The in-flight promise is cached too: several launches
 * fired at once share one child process.
 */
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

/**
 * The single line of a failure's output worth putting in a dialog. Normally
 * the first; a Python traceback is the exception — its banner is the first
 * line and the error the user needs (`ModuleNotFoundError: ...`) is the last,
 * behind the frame dump.
 */
function complaintLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const first = lines[0] ?? "";
  if (first === "Traceback (most recent call last):") return lines.at(-1) ?? first;
  return first;
}

/**
 * The process boundary. Windows needs a shell, not as a shortcut but because
 * the usual `claude` is a `.cmd` shim that `execFile` cannot resolve on its
 * own; the command line is built through the same quoting rules as a real
 * launch, so a program path with spaces survives and no token can become an
 * operator. POSIX passes arguments directly and needs no shell at all.
 */
export function spawnCommandRunner(cwd: string): CommandRunner {
  const windows = process.platform === "win32";
  return (program, args, timeoutMs) => new Promise<CommandExecution>((resolve, reject) => {
    const options = { cwd, timeout: timeoutMs, windowsHide: true } as const;
    const done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
      // A string `code` is ENOENT and friends: the command never ran at all.
      if (error !== null && typeof (error as { code?: unknown }).code === "string") {
        reject(new Error(`${program}: ${error.message}`));
        return;
      }
      resolve({
        code: error === null ? 0 : (error as { code?: number }).code ?? 1,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    };
    if (!windows) {
      execFile(program, [...args], options, done);
      return;
    }
    let commandLine: string;
    try { commandLine = buildCommandLine("cmd", [program], args); }
    catch (error) { reject(error instanceof Error ? error : new Error("the command cannot be represented")); return; }
    exec(commandLine, options, done);
  });
}
