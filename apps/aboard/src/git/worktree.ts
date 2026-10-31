import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export class RunWorkspaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RunWorkspaceError";
  }
}

export function runWorkspacePath(options: {
  readonly workspaceRoot: string;
  readonly root?: string;
  /** Also fence a linked source checkout when names are anchored at the main checkout. */
  readonly sourceRoot?: string;
  readonly exists?: (path: string) => boolean;
}): string {
  const workspaceRoot = resolve(options.workspaceRoot);
  const configured = options.root?.trim() ?? "";
  const container = configured.length === 0
    ? dirname(workspaceRoot)
    : isAbsolute(configured) ? resolve(configured) : resolve(workspaceRoot, configured);
  const first = join(container, `${basename(workspaceRoot)}-1`);
  if (!isOutside(first, workspaceRoot) || options.sourceRoot !== undefined && !samePath(first, options.sourceRoot) && !isOutside(first, options.sourceRoot)) {
    throw new RunWorkspaceError(
      `The checkout would be created at ${first}, inside the project at ${workspaceRoot}. Point aboard.autoRun.worktree.root somewhere outside the project.`,
    );
  }
  const exists = options.exists ?? existsSync;
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(container, `${basename(workspaceRoot)}-${index}`);
    if (options.sourceRoot !== undefined && !isOutside(candidate, options.sourceRoot)) continue;
    if (!exists(candidate)) return candidate;
  }
  throw new RunWorkspaceError(`Aboard could not find an available checkout name beside ${workspaceRoot}.`);
}

function isOutside(path: string, root: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset.length > 0 && (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset));
}

/** Case-insensitive on Windows, where two spellings of one path are the same path. */
export function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path.replaceAll("/", sep));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** The scaffolded setup command for this platform, relative to the source checkout. */
export function setupCommandPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".abd/session-setup.ps1" : ".abd/session-setup.sh";
}

export function hasSetupCommands(source: string): boolean {
  let inBlockComment = false;
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("#>")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("<#")) {
      if (!line.includes("#>")) inBlockComment = true;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    return true;
  }
  return false;
}

/** The program and arguments that run the setup file on this platform. */
export function setupCommandLine(script: string, platform: NodeJS.Platform = process.platform): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] }
    : { command: "bash", args: [script] };
}

export interface SetupCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SetupCommandRunner {
  /** Resolves on success; rejects with a reason the user can act on. */
  run(request: SetupCommandRequest): Promise<void>;
}

export const processSetupCommandRunner: SetupCommandRunner = {
  run: (request) => new Promise((resolvePromise, reject) => {
    execFile(
      request.command,
      [...request.args],
      {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        timeout: request.timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error === null) return resolvePromise();
        const detail = typeof stderr === "string" && stderr.trim().length > 0 ? stderr.trim().slice(0, 2_000) : error.message;
        reject(new RunWorkspaceError(detail));
      },
    );
  }),
};
