import { createPiToolScenario } from "../../core/pi-scenario.js";
import { OpenAiProtocolError } from "../../core/openai-server.js";

export const MARKER = "[E2E:pi-test-workflows]";
export const SOURCE = "module.exports = (name) => `Hello, ${name}!`;\n";
export const REGRESSION = "module.exports = (name) => `Goodbye, ${name}!`;\n";
export const WORKFLOW = '---\ncovers: ["src/greet.cjs"]\n---\n\n## Steps\n\nGreet Ada.\n\n## Acceptance Criteria\n\n- The greeting is Hello, Ada!\n';
export const ACCEPTANCE = `const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const greet = require('./src/greet.cjs');
const passed = greet('Ada') === 'Hello, Ada!';
writeFileSync(process.argv[2], JSON.stringify({ passed }) + '\\n');
console.log(JSON.stringify({ passed }));
assert.equal(passed, true);
`;

/** The server supplies inference only; Pi executes the installed CLI and acceptance check. */
export function testWorkflowsScenario(shell: "powershell" | "bash") {
  const status = "test-workflows --directory checks --json status";
  return createPiToolScenario({
    name: "pi-test-workflows", marker: MARKER,
    steps: [
      { checkpoint: "initial-stale", tool: shell, input: { command: status }, verifyResult: (output) => states(output, { "greeting.md": "stale" }) },
      { checkpoint: "read-workflow", tool: "read", input: { path: "checks/greeting.md" } },
      { checkpoint: "passing-execution", tool: shell, input: { command: "node accept.cjs ../passing-evidence.json" }, verifyResult: (output) => acceptance(output, true) },
      { checkpoint: "explicit-confirmation", tool: shell, input: { command: 'test-workflows --json confirm "checks/greeting.md"' }, verifyResult: (output) => {
        const value = cliJson(output);
        if (value.state !== "passed" || value.workflow !== "checks/greeting.md") reject("confirmation did not record the passing workflow");
      } },
      { checkpoint: "confirmed-passed", tool: shell, input: { command: status }, verifyResult: (output) => states(output, { "greeting.md": "passed" }) },
      { checkpoint: "broken-coverage", tool: "write", input: { path: "checks/broken.md", content: WORKFLOW.replace("src/greet.cjs", "src/missing.cjs") } },
      { checkpoint: "invalid-format", tool: "write", input: { path: "checks/invalid.md", content: '---\ncovers: ["src/greet.cjs"]\n---\n\nMissing required sections.\n' } },
      { checkpoint: "explicit-invalid-and-broken", tool: shell, input: { command: status }, verifyResult: (output) => states(output, { "greeting.md": "passed", "broken.md": "broken", "invalid.md": "invalid" }) },
      { checkpoint: "covered-regression", tool: "edit", input: { path: "src/greet.cjs", oldText: SOURCE.trim(), newText: REGRESSION.trim() } },
      { checkpoint: "changed-file-stale", tool: shell, input: { command: status }, verifyResult: (output) => states(output, { "greeting.md": "stale", "broken.md": "broken", "invalid.md": "invalid" }, true) },
      { checkpoint: "failed-execution", tool: shell, input: { command: "node accept.cjs ../failing-evidence.json" }, verifyResult: (output) => acceptance(output, false) },
      { checkpoint: "failure-remains-stale", tool: shell, input: { command: status }, verifyResult: (output) => states(output, { "greeting.md": "stale", "broken.md": "broken", "invalid.md": "invalid" }, true) },
    ],
  });
}

function states(output: unknown, expected: Record<string, string>, changed = false): void {
  const workflows = cliJson(output).workflows;
  if (!Array.isArray(workflows) || workflows.length !== Object.keys(expected).length) reject("status returned an unexpected workflow inventory");
  for (const [name, state] of Object.entries(expected)) {
    const workflow = workflows.find((item: Record<string, unknown>) => item.workflow === `checks/${name}`) as Record<string, unknown> | undefined;
    if (workflow?.state !== state) reject("status did not preserve explicit workflow states");
    if (changed && name === "greeting.md" && JSON.stringify(workflow.changed_files) !== JSON.stringify(["src/greet.cjs"])) reject("stale status lost the changed covered file");
  }
}

function cliJson(output: unknown): Record<string, unknown> {
  for (const line of strings(output).split("\n")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && ("workflows" in parsed || "workflow" in parsed)) return parsed as Record<string, unknown>;
    } catch { /* Native shell tools may append exit status information. */ }
  }
  return reject("the installed CLI did not produce its JSON result contract");
}

function acceptance(output: unknown, passed: boolean): void {
  if (!strings(output).split("\n").some((line) => {
    try { return (JSON.parse(line) as { passed?: unknown }).passed === passed; } catch { return false; }
  })) reject("the real acceptance execution returned an unexpected result");
}

function strings(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(strings).join("\n");
  if (typeof value === "object" && value !== null) return Object.values(value).map(strings).join("\n");
  return "";
}
function reject(detail: string): never { throw new OpenAiProtocolError("$.input", detail, "pi-test-workflows"); }
