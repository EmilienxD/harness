import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  projectSlug,
  sessionTranscriptExists,
  sessionTranscriptPath,
} from "../src/claude/sessions.js";
import type { SessionId } from "../src/domain/contracts.js";

const sessionId = "4db0ed4c-5d9e-4ab5-a493-2b8575ab19ee" as SessionId;

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

  assert.equal(await sessionTranscriptExists(sessionId, "C:\\work", config), false);
  const directory = join(config, "projects", "C--work");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${sessionId}.jsonl`), "{}\n", "utf8");
  assert.equal(await sessionTranscriptExists(sessionId, "C:\\work", config), true);
});
