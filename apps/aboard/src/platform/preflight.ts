import { exec, execFile } from "node:child_process";

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
  context?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<CommandExecution>;

export type PreflightResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

export function spawnCommandRunner(cwd: string): CommandRunner {
  const windows = process.platform === "win32";
  return (program, args, timeoutMs, context) => new Promise<CommandExecution>((resolve, reject) => {
    const options = { cwd: context?.cwd ?? cwd, env: { ...process.env, ...context?.env }, timeout: timeoutMs, windowsHide: true } as const;
    const done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
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
