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
      const rows = (await readFile(path, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
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
      const named = ancestry.filter((entry) => entry.type === "session_info" && typeof entry.name === "string").at(-1)?.name as string | undefined;
      const firstUser = ancestry.find((entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null && (entry.message as { role?: unknown }).role === "user");
      const content = (firstUser?.message as { content?: unknown } | undefined)?.content;
      const preview = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((block: unknown): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string").map((block) => block.text).join(" ") : undefined;
      const title = (named?.trim() || preview?.trim())?.split(/\r?\n/u)[0]?.trim().slice(0, 120);
      return { path, ...(title ? { title } : {}) };
    } catch { continue; }
  }
  return undefined;
}
