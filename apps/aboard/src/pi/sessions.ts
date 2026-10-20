import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionId } from "../domain/contracts.js";

export function piAgentDirectory(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
async function settingsSessionDir(path: string, cwd: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(path, "utf8")) as { sessionDir?: unknown };
    return typeof settings.sessionDir === "string" ? resolve(cwd, settings.sessionDir.replace(/^~(?=[/\\])/u, homedir())) : undefined;
  } catch { return undefined; }
}
export async function piSessionDirectory(cwd: string, command: readonly string[] = []): Promise<string> {
  const option = command.lastIndexOf("--session-dir");
  const configured = option === -1 ? undefined : command[option + 1];
  return (configured === undefined ? undefined : resolve(cwd, configured))
    ?? (process.env.PI_CODING_AGENT_SESSION_DIR === undefined ? undefined : resolve(cwd, process.env.PI_CODING_AGENT_SESSION_DIR))
    ?? await settingsSessionDir(join(cwd, ".pi", "settings.json"), cwd)
    ?? await settingsSessionDir(join(piAgentDirectory(), "settings.json"), cwd)
    ?? join(piAgentDirectory(), "sessions");
}
export interface PiSession { readonly path: string; readonly title?: string; }

/** Pi 1.2 persists expanded skills; mirror its native parseSkillBlock display form. */
function userInput(text: string): string {
  const skill = text.match(/^<skill name="([^"]+)" location="[^"]+">\r?\n[\s\S]*?\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]+))?$/u);
  return skill === null ? text : `/skill:${skill[1]}${skill[2]?.trim() ? ` ${skill[2].trim()}` : ""}`;
}
export async function inspectPiSession(sessionId: SessionId, cwd: string, command?: readonly string[]): Promise<PiSession | undefined> {
  const root = await piSessionDirectory(cwd, command);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(root, e.name));
  for (const directory of entries.filter((e) => e.isDirectory())) {
    const files = await readdir(join(root, directory.name), { withFileTypes: true }).catch(() => []);
    paths.push(...files.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(root, directory.name, e.name)));
  }
  for (const path of paths) {
    if (!path.includes(sessionId)) continue;
    try {
      const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
      const rows: Record<string, unknown>[] = [];
      for (const [index, line] of lines.entries()) {
        try { rows.push(JSON.parse(line) as Record<string, unknown>); }
        catch (error) { if (index !== lines.length - 1) throw error; }
      }
      const header = rows.shift();
      const canonical = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
      if (header?.type !== "session" || header.id !== sessionId || typeof header.cwd !== "string" || canonical(header.cwd) !== canonical(cwd)) continue;
      const byId = new Map(rows.filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
      const ancestry: Record<string, unknown>[] = [];
      let current = rows.at(-1);
      const seen = new Set<unknown>();
      while (current !== undefined) {
        if (typeof current.id !== "string" || seen.has(current.id)) throw new Error("Invalid Pi ancestry");
        seen.add(current.id); ancestry.unshift(current);
        if (current.parentId === null) break;
        current = byId.get(current.parentId);
        if (current === undefined) throw new Error("Missing Pi parent");
      }
      if (!ancestry.some((entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null && (entry.message as { role?: unknown }).role === "user")) continue;
      // Like Pi's getSessionName(), names are session-wide; an empty latest name clears it.
      const named = rows.filter((entry) => entry.type === "session_info").at(-1)?.name;
      const firstUser = ancestry.find((entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null && (entry.message as { role?: unknown }).role === "user");
      const content = (firstUser?.message as { content?: unknown } | undefined)?.content;
      const preview = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((block: unknown): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string").map((block) => block.text).join(" ") : undefined;
      const title = ((typeof named === "string" ? named.trim() : undefined) || (preview === undefined ? undefined : userInput(preview).trim()));
      return { path, ...(title ? { title } : {}) };
    } catch { continue; }
  }
  return undefined;
}
