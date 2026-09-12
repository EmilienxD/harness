import assert from "node:assert/strict";
import test from "node:test";

import { redactProcessError } from "../e2e/chatgpt.js";

test("ChatGPT E2E process diagnostics redact all captured content", () => {
  const captured = '{"prompt":"private user prompt","tool_input":"Bearer secret-token"}';

  const diagnostic = redactProcessError(captured);

  assert.match(diagnostic, /^\d+ bytes redacted$/u);
  assert.equal(diagnostic.includes("private user prompt"), false);
  assert.equal(diagnostic.includes("tool_input"), false);
  assert.equal(diagnostic.includes("secret-token"), false);
});

test("ChatGPT E2E process diagnostics distinguish empty output", () => {
  assert.equal(redactProcessError(""), "no output");
});
