/**
 * Session transcript discovery.
 *
 * `claude --resume <id>` fails with "No conversation found with session ID"
 * unless the transcript holds an actual conversation. The bridge detects that
 * case up front and relaunches the session afresh under the same id
 * (`--session-id`) instead of asking the caller to recover from a dead terminal.
 *
 * The test cannot be the transcript's existence. Claude Code creates the file as
 * soon as the TUI opens and writes session metadata into it — `mode`,
 * `permission-mode`, `bridge-session`, `last-prompt`, `queue-operation`,
 * `agent-setting` — so a session abandoned before its first exchange leaves a
 * file behind that `--resume` then refuses. Those metadata records are flat
 * settings rows; conversation records instead carry the message DAG, a `uuid`
 * and a `parentUuid`. The presence of one such record is what makes a session
 * resumable, and it is what this module looks for. Observed directly: a
 * transcript holding nothing but a `bridge-session` row is refused, while one
 * holding two `system` rows (a cancelled `/resume`, no user message at all)
 * resumes fine.
 *
 * Transcripts live at `<config>/projects/<slug>/<session-id>.jsonl`, where
 * `<slug>` is the session's working directory with every non-alphanumeric
 * character replaced by `-`. Neither the slug format nor the record shape is
 * contractual, so every uncertain answer resolves to "not resumable": a wrong
 * guess costs a fresh launch under the imposed session id, never a failure.
 */

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

/**
 * True when the line is a conversation record rather than a settings row. Both
 * keys must be present, but `parentUuid` is null on the first record of a
 * conversation, so presence — not truthiness — is the test.
 */
export function isConversationRecord(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let parsed: unknown;
  // A transcript is appended to live; a torn final line is normal, not a fault.
  try { parsed = JSON.parse(trimmed) as unknown; } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return "uuid" in parsed && "parentUuid" in parsed;
}

/**
 * Whether `claude --resume <sessionId>` will find a conversation. Reads the
 * transcript line by line and stops at the first conversation record, so the
 * common case costs a few lines rather than a multi-megabyte transcript.
 */
export async function sessionIsResumable(
  sessionId: SessionId,
  cwd: string,
  configDirectory?: string,
): Promise<boolean> {
  return transcriptHoldsConversation(sessionTranscriptPath(sessionId, cwd, configDirectory));
}

/**
 * The same test against an explicit path, so a backup copy can be checked
 * before it is restored over a transcript Claude Code no longer has.
 */
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
