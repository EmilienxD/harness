import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isConversationRecord,
  projectSlug,
  sessionIsResumable,
  sessionTranscriptPath,
} from "../../src/claude/sessions.js";
import type { SessionId } from "../../src/domain/contracts.js";

const sessionId = "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId;

// Verbatim rows from real transcripts. The metadata rows are what a session
// abandoned before its first exchange leaves behind, and `--resume` refuses it.
const BRIDGE_SESSION = `{"type":"bridge-session","sessionId":"${sessionId}","bridgeSessionId":"cse_015Ufcwm","lastSequenceNum":0}`;
const MODE = `{"type":"mode","mode":"normal","sessionId":"${sessionId}"}`;
const LAST_PROMPT = `{"type":"last-prompt","prompt":"hi"}`;
// A cancelled /resume writes only system rows, no user message; and resumes.
const SYSTEM = `{"type":"system","parentUuid":null,"isSidechain":false,"subtype":"local_command","content":"<command-name>/resume</command-name>","uuid":"5f044bf2-92ad-4df9-9e36-e9690c5fc09f","isMeta":false}`;

async function transcript(lines: readonly string[]): Promise<string> {
  const config = await mkdtemp(join(tmpdir(), "aboard-config-"));
  const directory = join(config, "projects", "C--work");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${sessionId}.jsonl`), lines.join("\n"), "utf8");
  return config;
}

test("the project slug replaces every non-alphanumeric character", () => {
  assert.equal(projectSlug("C:\\Users\\emb\\dev\\aboard"), "C--Users-emb-dev-aboard");
  assert.equal(projectSlug("/home/user/dev/my projet.v2"), "-home-user-dev-my-projet-v2");
});

test("the transcript lives under projects/<slug>/<session-id>.jsonl", async () => {
  const config = await mkdtemp(join(tmpdir(), "aboard-config-"));
  assert.equal(
    sessionTranscriptPath(sessionId, "C:\\work", config),
    join(config, "projects", "C--work", `${sessionId}.jsonl`),
  );

  assert.equal(await sessionIsResumable(sessionId, "C:\\work", config), false);
});

test("a transcript holding only session metadata is not resumable", async () => {
  // The bug: the file exists, so the old existence check said "resume" and the
  // CLI answered "No conversation found with session ID".
  const config = await transcript([MODE, BRIDGE_SESSION, LAST_PROMPT, ""]);
  assert.equal(await sessionIsResumable(sessionId, "C:\\work", config), false);
});

test("a conversation record makes the session resumable, user message or not", async () => {
  const config = await transcript([MODE, BRIDGE_SESSION, SYSTEM, ""]);
  assert.equal(await sessionIsResumable(sessionId, "C:\\work", config), true);
});

test("a missing transcript resolves to a fresh launch rather than a failure", async () => {
  const config = await mkdtemp(join(tmpdir(), "aboard-config-"));
  assert.equal(await sessionIsResumable(sessionId, "C:\\work", config), false);
});

test("conversation records are told apart by the message DAG, not by type", () => {
  assert.equal(isConversationRecord(SYSTEM), true);
  assert.equal(isConversationRecord(BRIDGE_SESSION), false);
  assert.equal(isConversationRecord(MODE), false);
  // parentUuid is null on the first record of a conversation: presence counts.
  assert.equal(isConversationRecord(`{"type":"user","uuid":"a","parentUuid":null}`), true);
  // A transcript is appended to live, so the last line can be torn.
  assert.equal(isConversationRecord(`{"type":"user","uuid":"a","paren`), false);
  assert.equal(isConversationRecord(""), false);
  assert.equal(isConversationRecord("[]"), false);
});
