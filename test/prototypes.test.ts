import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilePrototypeFolderAllocator, prototypeSlug } from "../src/bridge/prototypes.js";
import type { AgentId } from "../src/domain/contracts.js";

test("prototype slugs are stable, bounded, and usable when the description has no ASCII words", () => {
  assert.equal(prototypeSlug("  Test parser: streaming / retry!  "), "test-parser-streaming-retry");
  assert.equal(prototypeSlug("ééé"), "eee");
  assert.equal(prototypeSlug("---"), "experiment");
  assert.ok(prototypeSlug("a very long ".repeat(20)).length <= 48);
});

test("prototype folders are created exclusively under .aboard and disambiguated without deleting prior work", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-prototypes-"));
  const allocator = new FilePrototypeFolderAllocator(root);
  const agentId = "7" as AgentId;
  const first = await allocator.allocate(agentId, "Test parser API behavior");
  const second = await allocator.allocate(agentId, "Test parser API behavior");
  assert.equal(first, join(root, ".aboard", "prototypes", "7-test-parser-api-behavior"));
  assert.equal(second, join(root, ".aboard", "prototypes", "7-test-parser-api-behavior-2"));
  assert.equal((await stat(first)).isDirectory(), true);
  assert.equal((await stat(second)).isDirectory(), true);
});
