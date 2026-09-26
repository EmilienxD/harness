import assert from "node:assert/strict";
import test from "node:test";

import { runPreferFewerCommentsJourney } from "../tools/prefer-fewer-comments/run.js";
import { CONTENT, type Method, type Platform } from "../tools/prefer-fewer-comments/scenario.js";

for (const [platform, methods] of [["claude", ["native", "shell", "printf"]], ["chatgpt", ["shell"]]] as const satisfies readonly (readonly [Platform, readonly Method[]])[]) {
  for (const method of methods) {
    test(`prefer-fewer-comments reaches the real ${platform} CLI after a ${method} write`, async () => {
      const result = await runPreferFewerCommentsJourney(platform, method);
      assert.deepEqual(result.checkpoints, ["write", "reminder"]);
      assert.equal(result.content.replaceAll("\r\n", "\n"), CONTENT);
      assert.equal(result.unexpectedRequests, 0);
    });
  }
}
