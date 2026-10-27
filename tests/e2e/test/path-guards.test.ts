import test from "node:test";
import assert from "node:assert/strict";
import { runSharedLocalGuards, runSharedPiGuards } from "../tools/path-guards/run.js";
import { guardProgress } from "../tools/path-guards/scenario.js";

test("guard scenarios reject unexpected and incomplete histories with redacted diagnostics", () => {
  for (const provider of ["claude", "chatgpt"] as const) {
    const call = provider === "claude" ? { type: "tool_use", id: "unknown-private-id", input: { secret: "private-payload" } } : { type: "function_call", call_id: "unknown-private-id", arguments: "private-payload" };
    const result = provider === "claude" ? { type: "tool_result", tool_use_id: "unknown-private-id" } : { type: "function_call_output", call_id: "unknown-private-id" };
    for (const history of [[call], [call, result]]) assert.throws(() => guardProgress(history, 11, provider), error => {
      assert.ok(error instanceof Error);
      assert.equal(/unknown-private-id|private-payload/.test(error.message), false);
      return true;
    });
  }
});

for (const provider of ["claude", "chatgpt"] as const) test(`real ${provider} shared guards cover native tools, shell reads and shell writes`, { timeout: 120_000 }, () => runSharedLocalGuards(provider));
test("real Pi RPC shared guards cover native tools and PowerShell/Bash through fake OpenAI", { timeout: 120_000 }, runSharedPiGuards);
