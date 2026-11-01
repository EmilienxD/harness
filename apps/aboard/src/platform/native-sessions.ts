import { open, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { AgentPlatformId, SessionId } from "../domain/contracts.js";
import { ProcessGitClient } from "../git/client.js";
import { samePath } from "../git/worktree.js";
import { claudeConfigDirectory, projectSlug } from "../claude/sessions.js";
import { ChatGptSessionProbe } from "../chatgpt/sessions.js";
import { piSessionDirectory, userInput as piUserInput } from "../pi/sessions.js";

export interface NativeSession {
  readonly platform: AgentPlatformId;
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly at: string;
  readonly title?: string;
}
async function files(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(directory, entry.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function projectSessionRoots(cwd: string): Promise<readonly string[]> {
  const trees = await new ProcessGitClient(cwd).worktrees().catch(() => []);
  const roots = [cwd];
  for (const tree of trees) if (!roots.some((root) => samePath(root, tree.path)) && (await stat(tree.path).catch(() => undefined))?.isDirectory()) roots.push(tree.path);
  return roots;
}
function rows(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    try { const row: unknown = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : []; } catch { return []; }
  });
}
function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block: { type?: string; text?: string }) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join(" ") : undefined;
}
/** Display metadata only. Full conversation validation belongs to the selected resume. */
async function claudeMetadata(path: string, cwd: string, at: string): Promise<NativeSession | undefined> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const head = Buffer.alloc(Math.min(size, 65536));
    await file.read(head, 0, head.length, 0);
    const tail = size > head.length ? Buffer.alloc(Math.min(size, 65536)) : head;
    if (tail !== head) await file.read(tail, 0, tail.length, size - tail.length);
    const entries = [...rows(head.toString("utf8")), ...(tail === head ? [] : rows(tail.toString("utf8")))];
    if (entries[0]?.isSidechain === true || entries[0]?.teamName) return undefined;
    const latest = [...entries].reverse();
    const custom = latest.find((row) => typeof row.customTitle === "string")?.customTitle;
    const generated = latest.find((row) => typeof row.aiTitle === "string")?.aiTitle;
    const last = latest.find((row) => typeof row.lastPrompt === "string")?.lastPrompt;
    const preview = messageText(entries.find((row) => row.type === "user" && row.isMeta !== true)?.message);
    const userTitle = typeof custom === "string" && /^aboard-(?:interactive|explore|prototype|websearch|brainstorm|general|address|review)-\d+$/u.test(custom) ? undefined : custom;
    const title = [userTitle, generated, last, preview].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    const sessionId = path.slice(path.lastIndexOf("/") + 1).split("\\").at(-1)!.slice(0, -6) as SessionId;
    return { platform: "claude", sessionId, cwd, at, title: title ?? "Untitled conversation" };
  } finally { await file.close(); }
}
async function piMetadata(path: string, roots: readonly string[], fallback: string, signal?: AbortSignal): Promise<NativeSession | undefined> {
  const input = createReadStream(path, { encoding: "utf8", ...(signal ? { signal } : {}) });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  let title: string | undefined;
  let preview: string | undefined;
  let at = fallback;
  try {
    for await (const line of lines) {
      const row = rows(line)[0];
      if (!row) continue;
      if (!header) {
        if (row.type !== "session" || typeof row.id !== "string" || typeof row.cwd !== "string" || !roots.some((root) => samePath(root, row.cwd as string))) return undefined;
        header = row; continue;
      }
      if (row.type === "session_info") title = typeof row.name === "string" ? row.name.trim() || undefined : undefined;
      const message = row.message as { role?: string; timestamp?: number } | undefined;
      if (row.type === "message" && (message?.role === "user" || message?.role === "assistant")) {
        if (message.role === "user" && !preview) preview = messageText(message);
        const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp) : typeof row.timestamp === "string" ? new Date(row.timestamp) : undefined;
        if (timestamp && Number.isFinite(timestamp.getTime())) at = timestamp.toISOString();
      }
    }
    return header && preview ? { platform: "pi", sessionId: header.id as SessionId, cwd: header.cwd as string, at, title: title ?? piUserInput(preview) } : undefined;
  } finally { lines.close(); input.destroy(); }
}

/** Fresh discovery, bounded reads, and incremental publication; never launches a per-row probe. */
export async function discoverNativeSessions(options: {
  readonly cwd: string;
  readonly command: (platform: AgentPlatformId, cwd: string) => Promise<readonly string[] | undefined>;
  readonly log: (message: string) => void;
  readonly publish?: (sessions: readonly NativeSession[]) => void;
  readonly signal?: AbortSignal;
}): Promise<readonly NativeSession[]> {
  const roots = await projectSessionRoots(options.cwd);
  const sessions = new Map<string, NativeSession>();
  const publish = (found: readonly NativeSession[]) => {
    for (const session of found) sessions.set(`${session.platform}:${session.sessionId}`, session);
    options.publish?.([...sessions.values()]);
  };
  const piDirectories = new Map<string, string[]>();
  await Promise.all(roots.map(async (cwd) => {
    try {
      const directory = await piSessionDirectory(cwd, await options.command("pi", cwd));
      const existing = [...piDirectories.keys()].find((path) => samePath(path, directory)) ?? directory;
      piDirectories.set(existing, [...piDirectories.get(existing) ?? [], cwd]);
    } catch (error) { options.log(`Pi history in ${cwd}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  const jobs: (() => Promise<void>)[] = [];
  const scan = async (paths: readonly string[], read: (path: string, at: string) => Promise<NativeSession | undefined>) => {
    const candidates = (await Promise.all(paths.map(async (path) => {
      const info = await stat(path).catch(() => undefined);
      return info ? { path, time: info.mtimeMs, at: info.mtime.toISOString() } : undefined;
    }))).filter((value) => value !== undefined).sort((a, b) => b.time - a.time);
    for (let index = 0; index < candidates.length && !options.signal?.aborted; index += 8) {
      const found = await Promise.all(candidates.slice(index, index + 8).map(async (file) => {
        try { return await read(file.path, file.at); } catch { return undefined; }
      }));
      publish(found.filter((value) => value !== undefined));
    }
  };
  for (const cwd of roots) {
    jobs.push(async () => scan(await files(join(claudeConfigDirectory(), "projects", projectSlug(cwd))), (path, at) => claudeMetadata(path, cwd, at)));
    jobs.push(async () => {
      try { await new ChatGptSessionProbe().list(cwd, await options.command("chatgpt", cwd), (page) => {
        if (!options.signal?.aborted) publish(page.filter((session) => samePath(session.cwd, cwd)).map((session) => ({ ...session, platform: "chatgpt" })));
      }, options.signal); } catch (error) { throw new Error(`chatgpt history in ${cwd}: ${error instanceof Error ? error.message : String(error)}`); }
    });
  }
  for (const [directory, checkouts] of piDirectories) jobs.push(async () => {
    const paths = await files(directory);
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) if (child.isDirectory()) paths.push(...await files(join(directory, child.name)));
    await scan(paths, (path, at) => piMetadata(path, checkouts, at, options.signal));
  });
  await Promise.all(jobs.map(async (job) => {
    try { await job(); } catch (error) { if (!options.signal?.aborted) options.log(`Reopen history: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  return [...sessions.values()];
}
