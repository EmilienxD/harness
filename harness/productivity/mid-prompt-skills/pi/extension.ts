import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

/** Load only resources resolved by Pi, without rediscovering skills or dispatching commands. */
export default function (pi: any): void {
  pi.on("input", async (event: any) => {
    const text: string = event.text;
    const excluded: [number, number][] = [];
    // Closing fences may be longer than their opener. An unclosed fence protects the rest of the input.
    const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)];
    let fence: { start: number; character: string; length: number } | undefined;
    for (const line of lines) {
      const match = /^[ \t]*(`{3,}|~{3,})(.*)/.exec(line[0]);
      if (!match) continue;
      const run = match[1]!;
      if (!fence) fence = { start: line.index!, character: run[0]!, length: run.length };
      else if (run[0] === fence.character && run.length >= fence.length && !match[2]!.trim()) {
        excluded.push([fence.start, line.index! + line[0].length]);
        fence = undefined;
      }
    }
    if (fence) excluded.push([fence.start, text.length]);
    for (const match of text.matchAll(/(`+)([^`]|(?!\1)`)*?\1/g)) excluded.push([match.index!, match.index! + match[0].length]);
    const protectedAt = (index: number) => excluded.some(([start, end]) => start <= index && index < end);
    const loaded = new Set<string>();
    // Native expansion runs after input handlers; never expand or duplicate that first skill here.
    const leading = /^\/skill:([^\s]+)/.exec(text);
    if (leading) loaded.add(leading[1]!);
    for (const match of text.matchAll(/<skill\s+name="([^"]+)"\s+location="[^"]*">[\s\S]*?<\/skill>/g)) {
      if (!protectedAt(match.index!)) {
        loaded.add(match[1]!);
        excluded.push([match.index!, match.index! + match[0].length]);
      }
    }
    const commands = new Map<string, string>();
    for (const command of pi.getCommands()) {
      if (command.source === "skill" && command.sourceInfo?.path) commands.set(command.name, command.sourceInfo.path);
    }
    const blocks: string[] = [];
    for (const match of text.matchAll(/(?<!\S)\/skill:([A-Za-z0-9][\w.-]*)(?=\s|$)/g)) {
      if (!text.slice(0, match.index).trim() || protectedAt(match.index!)) continue;
      const name = match[1]!;
      if (loaded.has(name)) continue;
      const path = commands.get(`skill:${name}`);
      if (!path) continue;
      try {
        const body = stripFrontmatter(await readFile(path, "utf8")).trim();
        blocks.push(`<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`);
        loaded.add(name);
      } catch {
        pi.sendMessage({ customType: "harness-mid-prompt-skills", content: `Could not load skill ${name}. Reload Pi after restoring the skill file before retrying.`, display: true }, { triggerTurn: false });
        return { action: "handled" };
      }
    }
    if (blocks.length) return { action: "transform", text: `${text}\n\n${blocks.join("\n\n")}`, images: event.images };
  });
}
