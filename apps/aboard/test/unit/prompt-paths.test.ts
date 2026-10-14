import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeFileReferences } from "../../src/platform/prompt-paths.js";

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`file references use native separators on ${platform} and preserve other at-signs`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "aboard-paths-"));
    try {
      writeFileSync(join(cwd, "LICENSE"), "");
      mkdirSync(join(cwd, "src"));
      const converted = normalizeFileReferences(
        '(`@src/core.py`), @"C:\\a project\\notes.md"; @LICENSE @src @owner dev@example.com https://example.com/@src/file.',
        cwd, platform,
      );
      assert.deepEqual([...converted.matchAll(/`([^`]+)`|"([^"]+)"/gu)].map((match) => match[1] ?? match[2]),
        platform === "win32" ? ["src\\core.py", "C:\\a project\\notes.md"] : ["src/core.py", "C:/a project/notes.md"]);
      assert.deepEqual(converted.match(/@\S+/gu), ["@owner", "@example.com", "@src/file."]);
      assert.ok(converted.split(/\s/gu).includes("LICENSE"));
      assert.ok(converted.split(/\s/gu).includes("src"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
