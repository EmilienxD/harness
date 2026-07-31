/**
 * Session transcript discovery.
 *
 * Claude Code only writes a session transcript once the conversation receives
 * its first message. A session closed before that first message has no
 * transcript on disk, and `claude --resume <id>` then fails with
 * "No conversation found". The bridge detects that case up front and relaunches
 * the session afresh under the same id (`--session-id`) instead of asking the
 * caller to recover from a dead terminal.
 *
 * Transcripts live at `<config>/projects/<slug>/<session-id>.jsonl`, where
 * `<slug>` is the session's working directory with every non-alphanumeric
 * character replaced by `-`. The slug format is not contractual; a wrong guess
 * degrades to an unnecessary fresh launch under the imposed session id, never
 * to a failure.
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function sessionTranscriptExists(
  sessionId: SessionId,
  cwd: string,
  configDirectory?: string,
): Promise<boolean> {
  try {
    await access(sessionTranscriptPath(sessionId, cwd, configDirectory));
    return true;
  } catch {
    return false;
  }
}
