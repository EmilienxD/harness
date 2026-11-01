import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildCommandLine } from "../platform/shell.js";
import type { ChatGptAppServerRequest } from "./sessions.js";

/** One initialized transport for an entire paginated listing. No inference requests. */
export class SessionListConnection {
  readonly child;
  readonly lines;
  readonly ready: Promise<void>;
  readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  nextId = 2;
  closed = false;
  constructor(command: readonly string[], cwd: string, private readonly signal?: AbortSignal) {
    const [program, ...fixed] = command;
    if (!program) throw new Error("The configured Codex command is empty");
    const args = [...fixed, "app-server", "--listen", "stdio://"];
    const windows = process.platform === "win32";
    this.child = spawn(windows ? buildCommandLine("cmd", [program], args) : program, windows ? [] : args,
      { cwd, windowsHide: true, shell: windows, stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let response: { id?: number; result?: unknown; error?: unknown };
      try { response = JSON.parse(line); } catch { return; }
      if (!response || typeof response.id !== "number") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id); clearTimeout(pending.timer);
      if (response.error !== undefined) pending.reject(response.error); else pending.resolve(response.result);
    });
    this.child.stderr.resume();
    this.child.on("error", (error) => this.dispose(error));
    this.child.stdin.on("error", (error) => this.dispose(error));
    this.child.on("close", () => this.dispose(new Error("Codex session listing process exited")));
    signal?.addEventListener("abort", this.abort, { once: true });
    this.ready = this.send(1, "initialize", { clientInfo: { name: "aboard", title: "Aboard", version: "0.0.0" } }).then(() => {
      this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    });
    // A cancellation can happen before the first caller awaits readiness.
    void this.ready.catch(() => undefined);
    if (signal?.aborted) this.abort();
  }
  private readonly abort = () => this.dispose(new Error("Session listing cancelled"));
  private send(id: number, method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Session listing connection is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error("Codex session listing timed out")), 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async exchange(request: ChatGptAppServerRequest): Promise<unknown> {
    await this.ready;
    return this.send(this.nextId++, request.method, request.params);
  }
  dispose(error: unknown = new Error("Session listing closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.lines.close(); this.child.kill();
  }
}
