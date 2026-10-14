import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FILE_REFERENCE = /(?<![\w@/\\])@("[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s`"'<>()[\]{},;!?]+)/gu;

/** Adapt Claude-style file references for delivery to Codex. */
export function normalizeFileReferences(prompt: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): string {
  return prompt.replace(FILE_REFERENCE, (match: string, reference: string) => {
    const quoted = /^["'`]/u.test(reference);
    const path = quoted ? reference.slice(1, -1) : reference.replace(/[.:]+$/u, "");
    if (!path || path.includes("@") || path.includes("://")) return match;
    if (!/[\/\\.]/u.test(path) && !existsSync(resolve(cwd, path))) return match;
    const normalized = platform === "win32" ? path.replaceAll("/", "\\") : path.replaceAll("\\", "/");
    return quoted ? reference[0] + normalized + reference.at(-1) : normalized + reference.slice(path.length);
  });
}
