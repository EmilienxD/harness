
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { SessionId } from "../domain/contracts.js";

export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function sessionTranscriptPath(
  sessionId: SessionId,
  cwd: string,
  configDirectory: string = claudeConfigDirectory(),
): string {
  return join(configDirectory, "projects", projectSlug(cwd), `${sessionId}.jsonl`);
}

export function isConversationRecord(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let parsed: unknown;
  // A transcript is appended to live; a torn final line is normal, not a fault.
  try { parsed = JSON.parse(trimmed) as unknown; } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return "uuid" in parsed && "parentUuid" in parsed;
}

export async function sessionIsResumable(
  sessionId: SessionId,
  cwd: string,
  configDirectory?: string,
): Promise<boolean> {
  return transcriptHoldsConversation(sessionTranscriptPath(sessionId, cwd, configDirectory));
}

/** Reads only display metadata from Claude's append-only conversation file. */
export async function claudeSessionTitle(
  sessionId: SessionId,
  cwd: string,
  configDirectory?: string,
): Promise<string | undefined> {
  const stream = createReadStream(sessionTranscriptPath(sessionId, cwd, configDirectory), { encoding: "utf8" });
  let generated: string | undefined;
  let named: string | undefined;
  let preview: string | undefined;
  let hasUserMessage = false;
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          record = parsed as Record<string, unknown>;
        } catch { continue; } // The last line may still be in flight.
        if (record.sessionId !== sessionId) continue;
        if (record.type === "ai-title" && typeof record.aiTitle === "string") generated = displayTitle(record.aiTitle);
        if (record.type === "custom-title" && typeof record.customTitle === "string") named = displayTitle(record.customTitle);
        if (!hasUserMessage && isUserMessage(record)) {
          hasUserMessage = true;
          const message = record.message;
          if (typeof message === "object" && message !== null && !Array.isArray(message)) {
            const content = (message as Record<string, unknown>).content;
            if (typeof content === "string") preview = displayTitle(content);
            else if (Array.isArray(content)) preview = displayTitle(content.flatMap((block: unknown) =>
              typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join(" "));
          }
        }
      }
    } finally { lines.close(); }
  } catch { return undefined; }
  finally { stream.destroy(); }
  if (!hasUserMessage) return undefined;
  return named !== undefined && !/^aboard-(?:interactive|explore|prototype|websearch|brainstorm|general|address|review)-\d+$/u.test(named)
    ? named : generated ?? preview;
}

function displayTitle(value: string): string | undefined {
  const title = value.trim();
  return title === undefined || title.length === 0 ? undefined : title;
}

function isUserMessage(record: Record<string, unknown>): boolean {
  return record.type === "user" && record.isMeta !== true && typeof record.message === "object" && record.message !== null
    && (record.message as { role?: unknown }).role === "user";
}

export async function transcriptHoldsConversation(path: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          if (isUserMessage(JSON.parse(line) as Record<string, unknown>)) return true;
        } catch { /* The final line may still be in flight. */ }
      }
      return false;
    } finally {
      lines.close();
    }
  } catch {
    // Missing file, unreadable directory, a config layout aboard guessed wrong:
    // all mean "start fresh under the same id", which is always safe.
    return false;
  } finally {
    stream.destroy();
  }
}
