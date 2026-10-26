import { readFile } from "node:fs/promises";

/** Execute the immutable package command shipped in a skill, rather than a host CLI. */
export async function skillCommand(skillPath: string, name: string) {
  const skill = await readFile(skillPath, "utf8");
  const match = new RegExp(`uvx --from (git\\+https://github\\.com/EmilienxD/harness@[a-f0-9]{40}#subdirectory=[^\\s\x60]+) ${name}(?=[\\s\x60])`, "u").exec(skill);
  if (!match) throw new Error(`Shipped ${name} command is missing an immutable source`);
  const args = ["--from", match[1]!, name];
  return { file: "uvx", args, shell: `uvx --from '${match[1]}' ${name}` };
}
