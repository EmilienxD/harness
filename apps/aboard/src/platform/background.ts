import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { TerminalCreationOptions, TerminalHandle } from "./terminals.js";
import type { ShellKind } from "./shell.js";

/** A detached shell starts the independently supervised provider wrapper. */
export function createBackgroundProcess(
  options: TerminalCreationOptions,
  shell: ShellKind,
  onExit: (handle: TerminalHandle) => void,
): TerminalHandle {
  let child: ChildProcess | undefined;
  let resolvePid!: (pid: number | undefined) => void;
  const processId = new Promise<number | undefined>((resolve) => { resolvePid = resolve; });
  const handle: TerminalHandle = {
    processId,
    exitStatus: undefined,
    sendText(command) {
      if (child !== undefined) throw new Error("Background execution already started");
      const root = options.env.ABOARD_RUNTIME_ROOT;
      if (root === undefined) throw new Error("Background execution requires persistent runtime storage");
      const logs = join(root, "executions", options.env.HARNESS_EXECUTION_ID ?? options.env.ABOARD_EXECUTION_ID ?? options.env.ABOARD_AGENT_ID ?? "independent");
      mkdirSync(logs, { recursive: true });
      const stdout = openSync(join(logs, "stdout.jsonl"), "a", 0o600);
      const stderr = openSync(join(logs, "stderr.log"), "a", 0o600);
      const executable = process.platform === "win32"
        ? shell === "cmd" ? "cmd.exe" : shell === "git-bash" ? "bash.exe" : "powershell.exe"
        : "/bin/sh";
      const args = shell === "cmd" && process.platform === "win32" ? ["/d", "/s", "/c", command]
        : shell === "powershell" && process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]
        : ["-c", command];
      try {
        // Windows processes survive their launcher without DETACHED_PROCESS;
        // PowerShell requires its hidden console to initialize and run commands.
        child = spawn(executable, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", stdout, stderr] });
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
      resolvePid(child.pid);
      child.once("error", () => {
        Object.assign(handle, { exitStatus: { code: undefined } });
        onExit(handle);
      });
      child.once("exit", (code) => {
        Object.assign(handle, { exitStatus: { code: code ?? undefined } });
        onExit(handle);
      });
      child.unref();
    },
    show() { throw new Error("Background executions have no visible terminal"); },
    dispose() {
      if (child?.pid === undefined) return;
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio:"ignore" }).unref();
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
      }
    },
  };
  return handle;
}
