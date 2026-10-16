import { spawn } from "node:child_process";

const MAX_BYTES = 2 * 1024 * 1024;

// The same interpreter preference as Harness's installer; argv never uses a shell.
const interpreters = [
  ["uv", "run", "--offline", "--no-project", "--no-managed-python"],
  ["python3"], ["python"], ["py"],
];

function run(argv: string[], payload: string, cwd: string | undefined, signal: AbortSignal, timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Pi helper cancelled")); return; }
    const child = spawn(argv[0], argv.slice(1), {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    // Stop the interpreter launcher and its Git/GitHub children together.
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); }
      }
    };
    const abort = () => { stop(); reject(new Error("Pi helper cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    let output = "";
    let bytes = 0;
    const timer = setTimeout(() => { stop(); reject(new Error("Pi helper timeout")); }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) { stop(); reject(new Error("Pi helper output limit")); }
      else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { stop(); reject(new Error("Pi helper output limit")); }
    });
    child.on("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code !== 0) reject(new Error("Pi helper subprocess failed"));
      else resolve(output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}

function encode(request: unknown): string {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Pi helper input limit");
  return payload;
}

function decode(response: string): any {
  const result = JSON.parse(response);
  if (result.version !== 1) {
    throw new Error("Pi helper protocol mismatch");
  }
  return result;
}

export async function requestPython(request: unknown, signal: AbortSignal, script: string, timeout = 10_000): Promise<any> {
  const payload = encode(request);
  for (const argv of interpreters) {
    try {
      const response = await run([...argv, script], payload, (request as any).cwd, signal, timeout);
      return { ...decode(response), launchArgv: argv };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Pi helpers require uv or Python 3.11+");
}

/** Call an installed helper executable, such as a uv tool entry point, with the same bounds. */
export async function requestCommand(argv: string[], request: unknown, signal: AbortSignal, timeout = 10_000): Promise<any> {
  try {
    return decode(await run(argv, encode(request), (request as any).cwd, signal, timeout));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Pi helper command is unavailable: ${argv[0]}`);
    throw error;
  }
}
