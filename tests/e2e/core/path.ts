import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export function containsPath(parent: string, candidate: string): boolean {
  const rel = relative(normalize(parent), normalize(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a CLI on PATH to a spawnable file. Windows CreateProcess ignores
 * PATHEXT, so a bare name never finds the `.cmd` shim that npm installs; the
 * launchers keep `shell: false`, so the concrete path is what makes them work.
 * Falls back to the bare name so a missing CLI still fails at spawn.
 */
export function resolveExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  const suffixes = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => suffix.length > 0);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function resolveNativeExecutable(command: string): string | undefined {
  if (isAbsolute(command) || dirname(command) !== ".") return undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const suffix of [".exe", ".com"] as const) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* keep searching */ }
    }
  }
  return undefined;
}

export interface SpawnableCommand {
  readonly file: string;
  readonly args: readonly string[];
}

function npmShimCommand(file: string, args: readonly string[]): SpawnableCommand | undefined {
  try {
    if (statSync(file).size > 65_536) return undefined;
    const contents = readFileSync(file, "utf8");
    const match = /&\s+"%_prog%"\s+"%dp0%\\([^"\r\n]+\.js)"\s+%\*\s*$/imu.exec(contents);
    if (match?.[1] === undefined) return undefined;
    const root = realpathSync(dirname(file));
    const entry = realpathSync(resolve(root, ...match[1].split("\\")));
    if (!containsPath(root, entry) || !statSync(entry).isFile()) return undefined;
    const localNode = join(root, "node.exe");
    const node = existsSync(localNode) ? localNode : resolveExecutable("node");
    if (/\.(?:cmd|bat)$/iu.test(node)) return undefined;
    return { file: node, args: [entry, ...args] };
  } catch {
    return undefined;
  }
}

/**
 * Node refuses to spawn a `.cmd`/`.bat` directly (CVE-2024-27980). Standard
 * npm shims are translated to their Node entry point so argv is never parsed
 * by cmd.exe. Unknown batch files fail closed.
 */
export function spawnableCommand(command: string, args: readonly string[]): SpawnableCommand {
  const file = resolveExecutable(command);
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(file)) return { file, args };
  const npmCommand = npmShimCommand(file, args);
  if (npmCommand !== undefined) return npmCommand;
  const native = resolveNativeExecutable(command);
  if (native !== undefined) return { file: native, args };
  throw new Error(`${command} resolves to the unsupported script shim ${file}; configure a native executable instead`);
}
