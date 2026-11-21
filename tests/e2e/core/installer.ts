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

/** Install checkout catalogue payloads with shipped runtime pins; confine state to the fixture. */
export async function runFixtureInstaller(workspace: PiWorkspace, operation: "install" | "uninstall" | "upgrade" | "list" | "info", packages: readonly string[] = [], options: {
  readonly scope?: "project" | "user";
  readonly platform?: "pi" | "chatgpt" | "claude";
  readonly dryRun?: boolean;
  /** Defaults to shipped pins; false explicitly opts into checkout runtimes. */
  readonly pinnedRuntimes?: boolean;
  /** An owned fixture catalogue can provide a selectable consumer of an internal package. */
  readonly catalogueRoot?: string;
} = {}): Promise<Record<string, unknown>> {
  const root = await findHarnessRoot();
  const scope = options.scope ?? "project";
  const targetArgs = operation === "info" ? [] : ["--platform", options.platform ?? "pi", "--scope", scope, ...(scope === "project" ? ["--root", workspace.projectRoot] : [])];
  const args = ["run", "--offline", "--no-sync", "--project", root, "python", "-m", "harness_cli", ...((options.pinnedRuntimes ?? !options.catalogueRoot) ? [] : ["--local", options.catalogueRoot ?? root]), operation, ...packages,
    ...targetArgs, "--json",
    ...(options.dryRun ? ["--dry-run"] : []),
  ];
  const command = spawnableCommand("uv", args);
  // Install/upgrade include real pinned-runtime acquisition and native npm installation.
  // Allow bounded download/build time, especially under Windows process contention.
  const timeoutMs = operation === "install" || operation === "upgrade" ? 120_000 : 30_000;
  // Only the installer needs the explicitly selected persistent hook interpreter.
  const python = process.env.HARNESS_PYTHON;
  const env = python === undefined ? workspace.env : { ...workspace.env, HARNESS_PYTHON: python };
  let stdout: string;
  try {
    stdout = (await execFileAsync(command.file, [...command.args], { cwd: workspace.projectRoot, env, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch { throw new Error(`Harness E2E installer ${operation} failed; run uv sync in the checkout before these journeys`); }
  let result: unknown;
  try { result = JSON.parse(stdout) as unknown; } catch { throw new Error("Harness E2E installer emitted invalid JSON"); }
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) throw new Error(`Harness E2E installer ${operation} did not succeed`);
  return result as Record<string, unknown>;
}
