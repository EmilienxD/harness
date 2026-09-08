
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

export async function transcriptHoldsConversation(path: string): Promise<boolean> {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (isConversationRecord(line)) return true;
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
