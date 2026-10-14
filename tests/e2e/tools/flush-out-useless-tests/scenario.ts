import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError, type OpenAiResponsesRequest, type OpenAiScenarioResponse } from "../../core/openai-server.js";

export const AUDIT_MARKER = "[E2E:flush-out-useless-tests]";
export const APPROVAL_MARKER = "[E2E:approved-test-cleanup]";
export const PRODUCTION = "module.exports = (a, b) => a + b;\n";
export const KEPT_TEST = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst sum = require('../src/sum.cjs');\n\ntest('adds two operands', () => assert.equal(sum(2, 3), 5));\n";
export const TAUTOLOGY = "\ntest('tautology', () => {\n  const actual = sum(2, 3);\n  assert.equal(actual, sum(2, 3));\n});\n";
export const ORIGINAL_TEST = KEPT_TEST + TAUTOLOGY;

export function flushScenario(shell: "powershell" | "bash") {
  const command = "node --test --test-reporter=tap tests/sum.test.cjs";
  const scenario = createPiToolScenario({
    name: "flush-out-useless-tests", marker: AUDIT_MARKER,
    steps: [
      { checkpoint: "passing-baseline", tool: shell, input: { command }, verifyResult: (output) => verifyTap(output, 2) },
      { checkpoint: "read-production", tool: "read", input: { path: "src/sum.cjs" } },
      { checkpoint: "read-tests", tool: "read", input: { path: "tests/sum.test.cjs" } },
      { checkpoint: "approved-cleanup", tool: "edit", input: { path: "tests/sum.test.cjs", oldText: TAUTOLOGY, newText: "" } },
      { checkpoint: "verified-cleanup", tool: shell, input: { command }, verifyResult: (output) => verifyTap(output, 1) },
    ],
  });
  return {
    scenarioCatalogHash: scenario.scenarioCatalogHash,
    transition: (request: OpenAiResponsesRequest): OpenAiScenarioResponse => {
      const approved = request.input.some((item) => item.role === "user" && strings(item.content).includes(APPROVAL_MARKER));
      const response = scenario.transition(request);
      if (!approved && (response.checkpoint === "verified-cleanup" || response.checkpoint === "complete")) throw new OpenAiProtocolError("$.input", "cleanup history has no explicit approval", "flush-out-useless-tests");
      if (response.checkpoint === "approved-cleanup" && !approved) return {
        scenario: "flush-out-useless-tests", checkpoint: "awaiting-approval",
        output: { type: "message", id: "msg_harness_flush_audit", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Both tests pass. Keep the independent addition assertion; remove the test that compares sum with itself. Approval is required before changing tests.", annotations: [] }] },
      };
      return response;
    },
  };
}

function verifyTap(output: unknown, expected: number): void {
  const text = strings(output);
  if (!new RegExp(`^# tests ${expected}\\r?$`, "mu").test(text) || !new RegExp(`^# pass ${expected}\\r?$`, "mu").test(text) || !/^# fail 0\r?$/mu.test(text)) throw new OpenAiProtocolError("$.input", "the real scoped baseline did not pass its TAP contract", "flush-out-useless-tests");
}

function strings(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(strings).join("\n");
  if (typeof value === "object" && value !== null) return Object.values(value).map(strings).join("\n");
  return "";
}
