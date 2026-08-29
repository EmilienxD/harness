import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectSlug } from "../src/claude/sessions.js";
import { OVERLAP_VERIFY_BYTES, TranscriptBackupStore } from "../src/claude/transcript-backup.js";
import type { SessionId } from "../src/domain/contracts.js";

const sessionId = "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId;
const other = "9a1c8f2b-0d34-4c77-9e51-6b0f2ac47d18" as SessionId;

/** A metadata row: present in every transcript, and never enough to resume. */
const METADATA = `{"type":"bridge-session","sessionId":"${sessionId}","lastSequenceNum":0}`;

function conversation(index: number, padding = 0): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `uuid-${index}`,
    parentUuid: index === 0 ? null : `uuid-${index - 1}`,
    message: { role: "assistant", content: "x".repeat(padding) },
  });
}

interface Fixture {
  readonly store: TranscriptBackupStore;
  readonly live: string;
  readonly backup: string;
  readonly directory: string;
  write(sessionId: SessionId, lines: readonly string[]): Promise<void>;
  remove(sessionId: SessionId): Promise<void>;
  livePath(sessionId: SessionId): string;
}

async function fixture(retain = 5): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aboard-transcripts-"));
  const workspaceRoot = join(root, "workspace");
  const configDirectory = join(root, "claude");
  await mkdir(workspaceRoot, { recursive: true });
  const projects = join(configDirectory, "projects", projectSlug(workspaceRoot));
  await mkdir(projects, { recursive: true });
  const store = new TranscriptBackupStore({ workspaceRoot, configDirectory: () => configDirectory, retain: () => retain });
  const livePath = (id: SessionId): string => join(projects, `${id}.jsonl`);
  return {
    store,
    directory: join(workspaceRoot, ".aboard", "runtime", "transcripts"),
    live: livePath(sessionId),
    backup: store.backupPath(sessionId),
    livePath,
    write: async (id, lines) => { await writeFile(livePath(id), lines.join("\n") + "\n", "utf8"); },
    remove: async (id) => { await rm(livePath(id), { force: true }); },
  };
}

/** Long enough that the overlap check cannot span the whole file. */
function bulk(count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => conversation(index, 400));
}

test("the first checkpoint copies the transcript whole", async () => {
  const fake = await fixture();
  await fake.write(sessionId, [METADATA, conversation(0)]);
  assert.equal(await fake.store.checkpoint(sessionId), "copied");
  assert.equal(await readFile(fake.backup, "utf8"), await readFile(fake.live, "utf8"));
  assert.equal(await fake.store.checkpoint(sessionId), "unchanged");
});

test("later checkpoints append only the bytes the transcript gained", async () => {
  const fake = await fixture();
  const lines = bulk(40);
  await fake.write(sessionId, lines);
  assert.equal(await fake.store.checkpoint(sessionId), "copied");
  assert.ok((await stat(fake.backup)).size > OVERLAP_VERIFY_BYTES, "the fixture must outgrow the overlap window");

  const marked = "@" + (await readFile(fake.backup, "utf8")).slice(1);
  await writeFile(fake.backup, marked, "utf8");

  await fake.write(sessionId, [...lines, conversation(40, 400)]);
  assert.equal(await fake.store.checkpoint(sessionId), "appended");
  const after = await readFile(fake.backup, "utf8");
  assert.equal(after[0], "@");
  assert.equal(after.slice(1), (await readFile(fake.live, "utf8")).slice(1));
});

test("a transcript that diverges from the backup is copied whole rather than spliced", async () => {
  const fake = await fixture();
  await fake.write(sessionId, bulk(20));
  assert.equal(await fake.store.checkpoint(sessionId), "copied");
  // Same session id, different conversation: appending would join two
  // transcripts into one unparseable file.
  const replacement = [METADATA, ...bulk(30).map((line) => line.replace("assistant", "user"))];
  await fake.write(sessionId, replacement);
  assert.equal(await fake.store.checkpoint(sessionId), "copied");
  assert.equal(await readFile(fake.backup, "utf8"), await readFile(fake.live, "utf8"));
});

test("a backup ahead of the live transcript is kept, not shrunk to it", async () => {
  const fake = await fixture();
  const lines = bulk(20);
  await fake.write(sessionId, lines);
  await fake.store.checkpoint(sessionId);
  const copied = await readFile(fake.backup, "utf8");
  // Claude Code swept the file and something recreated a stub under the same
  // id: the copy still holds the conversation, so it stays.
  await fake.write(sessionId, lines.slice(0, 3));
  assert.equal(await fake.store.checkpoint(sessionId), "ahead");
  assert.equal(await readFile(fake.backup, "utf8"), copied);
});

test("a session Claude Code has no transcript for is not backed up", async () => {
  const fake = await fixture();
  assert.equal(await fake.store.checkpoint(sessionId), "no-source");
  await assert.rejects(() => stat(fake.backup));
});

test("retention keeps the newest copies and prunes the rest", async () => {
  const fake = await fixture(2);
  const third = "3f7d6a10-2b45-4f88-8c31-77d5e9b1c204" as SessionId;
  const ordered: readonly SessionId[] = [sessionId, other, third];
  for (const [index, id] of ordered.entries()) {
    await fake.write(id, [conversation(0)]);
    assert.equal(await fake.store.checkpoint(id), "copied");
    // Age the copies apart explicitly: a same-millisecond mtime would make the
    // assertion depend on filesystem timestamp resolution.
    const at = new Date(Date.UTC(2026, 0, 1 + index));
    await utimes(fake.store.backupPath(id), at, at);
  }
  await assert.rejects(() => stat(fake.store.backupPath(sessionId)), "the oldest copy is pruned");
  await stat(fake.store.backupPath(other));
  await stat(fake.store.backupPath(third));
});

test("retention 0 turns off both the backup and the restore", async () => {
  const fake = await fixture(0);
  await fake.write(sessionId, [conversation(0)]);
  assert.equal(await fake.store.checkpoint(sessionId), "disabled");
  await assert.rejects(() => stat(fake.backup));
  assert.equal(await fake.store.restore(sessionId), "disabled");
});

test("a live transcript holding a conversation wins over the backup", async () => {
  const fake = await fixture();
  await fake.write(sessionId, bulk(5));
  await fake.store.checkpoint(sessionId);
  // The transcript Claude Code has is always the truth: a stale copy must never
  // overwrite a session that is still there.
  await fake.write(sessionId, [conversation(0), conversation(1)]);
  const live = await readFile(fake.live, "utf8");
  assert.equal(await fake.store.restore(sessionId), "live");
  assert.equal(await readFile(fake.live, "utf8"), live);
});

test("restore puts the copy back when the retention sweep has deleted the transcript", async () => {
  const fake = await fixture();
  await fake.write(sessionId, [METADATA, ...bulk(6)]);
  await fake.store.checkpoint(sessionId);
  const copied = await readFile(fake.backup, "utf8");
  await fake.remove(sessionId);
  assert.equal(await fake.store.restore(sessionId), "restored");
  assert.equal(await readFile(fake.live, "utf8"), copied);
});

test("restore recreates the projects directory the sweep took with it", async () => {
  const fake = await fixture();
  await fake.write(sessionId, [conversation(0)]);
  await fake.store.checkpoint(sessionId);
  await rm(join(fake.live, ".."), { recursive: true, force: true });
  assert.equal(await fake.store.restore(sessionId), "restored");
  assert.equal(await readFile(fake.live, "utf8"), await readFile(fake.backup, "utf8"));
});

test("a metadata-only transcript is replaced by the backup, because --resume refuses it", async () => {
  const fake = await fixture();
  await fake.write(sessionId, [METADATA, conversation(0)]);
  await fake.store.checkpoint(sessionId);
  await fake.write(sessionId, [METADATA]);
  assert.equal(await fake.store.restore(sessionId), "restored");
  assert.equal(await readFile(fake.live, "utf8"), await readFile(fake.backup, "utf8"));
});

test("a backup holding no conversation restores nothing", async () => {
  const fake = await fixture();
  await fake.write(sessionId, [METADATA]);
  assert.equal(await fake.store.checkpoint(sessionId), "copied");
  await fake.remove(sessionId);
  assert.equal(await fake.store.restore(sessionId), "no-backup");
  await assert.rejects(() => stat(fake.live));
});

test("a missing backup restores nothing", async () => {
  const fake = await fixture();
  assert.equal(await fake.store.restore(sessionId), "no-backup");
});

test("a failing backup reports rather than throws, so it can never refuse a launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-transcripts-"));
  const configDirectory = join(root, "claude");
  const projects = join(configDirectory, "projects", projectSlug(root));
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, `${sessionId}.jsonl`), conversation(0), "utf8");
  // The backup directory is a file: every write under it fails.
  const directory = join(root, "occupied");
  await writeFile(directory, "not a directory", "utf8");
  const logged: string[] = [];
  const store = new TranscriptBackupStore({ workspaceRoot: root, configDirectory: () => configDirectory, directory, log: (message) => logged.push(message) });
  assert.equal(await store.checkpoint(sessionId), "failed");
  assert.ok(logged.some((line) => line.startsWith("Manager transcript backup failed:")));
});
