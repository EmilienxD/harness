import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { spawnableCommand } from "./path.js";
import type { PiWorkspace } from "./pi.js";

/** JSON/RPC suppress interactive warnings; run the installed CLI's actual startup detector. */
export async function piLegacyDirectoryWarningCount(workspace: PiWorkspace): Promise<number> {
  const command = spawnableCommand("pi", []);
  let root = dirname(await realpath(command.args[0] ?? command.file));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") break;
    } catch { /* ascend from the CLI entry to its package */ }
    const parent = dirname(root);
    if (parent === root) throw new Error("Pi startup checks require the installed npm package");
    root = parent;
  }
  const script = `const { runMigrations } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(runMigrations(process.cwd()).deprecationWarnings.length));`;
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", script, pathToFileURL(join(root, "dist", "migrations.js")).href],
    { cwd: workspace.projectRoot, env: workspace.env, windowsHide: true, timeout: 15_000 });
  const count: unknown = JSON.parse(stdout);
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("Unexpected Pi startup warning count");
  return count;
}
