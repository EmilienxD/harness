import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { spawnableCommand } from "./path.js";
import type { PiWorkspace } from "./pi.js";

const execFileAsync = promisify(execFile);

export async function findHarnessRoot(start = process.cwd()): Promise<string> {
  let root = resolve(start);
  while (true) {
    try { await access(join(root, "src", "harness_cli", "__main__.py")); return root; } catch { }
    const parent = dirname(root);
    if (parent === root) throw new Error("Could not locate the Harness installer source");
    root = parent;
  }
}

/** Install actual local catalogue payloads, with all state confined to the Pi fixture. */
export async function runFixtureInstaller(workspace: PiWorkspace, operation: "install" | "uninstall" | "upgrade" | "list" | "info", packages: readonly string[] = [], options: {
  readonly scope?: "project" | "user";
  readonly platform?: "pi" | "chatgpt" | "claude";
  readonly dryRun?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const root = await findHarnessRoot();
  const scope = options.scope ?? "project";
  const targetArgs = operation === "info" ? [] : ["--platform", options.platform ?? "pi", "--scope", scope, ...(scope === "project" ? ["--root", workspace.projectRoot] : [])];
  const args = ["run", "--offline", "--no-sync", "--project", root, "python", "-m", "harness_cli", "--local", root, operation, ...packages,
    ...targetArgs, "--json",
    ...(options.dryRun ? ["--dry-run"] : []),
  ];
  const command = spawnableCommand("uv", args);
  let stdout: string;
  try {
    stdout = (await execFileAsync(command.file, [...command.args], { cwd: workspace.projectRoot, env: workspace.env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch { throw new Error(`Harness E2E installer ${operation} failed; run uv sync in the checkout before these journeys`); }
  let result: unknown;
  try { result = JSON.parse(stdout) as unknown; } catch { throw new Error("Harness E2E installer emitted invalid JSON"); }
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) throw new Error(`Harness E2E installer ${operation} did not succeed`);
  return result as Record<string, unknown>;
}
