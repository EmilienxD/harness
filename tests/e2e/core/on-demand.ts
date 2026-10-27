import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Launch the script copied beside an installed skill without a package manager. */
export function bundledCommand(skillPath: string, script: string, python: string, shell: "powershell" | "bash" = process.platform === "win32" ? "powershell" : "bash") {
  const path = join(dirname(skillPath), "scripts", script);
  const quote = (value: string) => `'${(shell === "bash" && process.platform === "win32" ? value.replaceAll("\\", "/") : value).replaceAll("'", shell === "powershell" ? "''" : `'"'"'`)}'`;
  return { file: python, args: [path], shell: `${shell === "powershell" ? "& " : ""}${quote(python)} ${quote(path)}` };
}

/** Execute the immutable package command shipped in a skill, rather than a host CLI. */
export async function skillCommand(skillPath: string, name: string) {
  const skill = await readFile(skillPath, "utf8");
  const match = new RegExp(`uvx --from (git\\+https://github\\.com/EmilienxD/harness@[a-f0-9]{40}#subdirectory=[^\\s\x60]+) ${name}(?=[\\s\x60])`, "u").exec(skill);
  if (!match) throw new Error(`Shipped ${name} command is missing an immutable source`);
  const args = ["--from", match[1]!, name];
  return { file: "uvx", args, shell: `uvx --from '${match[1]}' ${name}` };
}
