import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contains, loadConfig } from "../e2e/config.js";
import {
  childEnvironment,
  findFinalText,
  missingClaudeHelpStructures,
  parseClaudeVersion,
  parseStreamJson,
  redactProcessError,
} from "../e2e/smoke.js";
import { removeDirectoryWithRetries } from "../e2e/vscode/support.js";

test("VS Code E2E cleanup retries transient Windows directory locks", async () => {
  let observed: { readonly path: string; readonly options: unknown } | undefined;
  await removeDirectoryWithRetries("C:\\fixture\\.abd", async (path, options) => {
    observed = { path: String(path), options };
  });
  assert.deepEqual(observed, {
    path: "C:\\fixture\\.abd",
    options: { recursive: true, force: true, maxRetries: 20, retryDelay: 100 },
  });
});

test("E2E configuration rejects malformed repository slugs", () => {
  for (const repository of ["owner", "owner/repo/extra", "https://github.com/owner/repo", "owner repo/name"]) {
    assert.throws(() => loadConfig({ ABOARD_E2E_REPOSITORY: repository }), /exact owner\/name slug/u);
  }
});

test("E2E configuration keeps every generated path outside the aboard checkout", () => {
  const config = loadConfig({ ABOARD_E2E_ROOT: join(tmpdir(), "harness-e2e-independent") });
  const checkout = resolve(__dirname, "..", "..");
  for (const path of [config.runtimeRoot, config.cloneRoot, config.claudeConfigRoot, config.diagnosticsPath, config.ownershipPath, config.readinessPath]) {
    assert.equal(contains(checkout, path), false, path);
  }
});

test("path containment respects normalized Windows path segment boundaries", () => {
  assert.equal(contains("C:\\work\\aboard", "C:\\work\\aboard\\runtime"), true);
  assert.equal(contains("C:\\work\\aboard", "C:\\work\\aboard-other"), false);
  assert.equal(contains("C:\\work\\aboard\\nested\\..", "C:\\work\\aboard\\file"), true);
});

test("Claude version parsing accepts the minimum and newer semantic versions", () => {
  assert.deepEqual(parseClaudeVersion("2.1.261 (Claude Code)"), [2, 1, 261]);
  assert.deepEqual(parseClaudeVersion("3.0.0"), [3, 0, 0]);
});

test("Claude version parsing rejects malformed and older versions", () => {
  assert.throws(() => parseClaudeVersion("Claude Code current"), /Could not parse/u);
  assert.throws(() => parseClaudeVersion("2.1.260"), />= 2\.1\.261/u);
});

test("Claude compatibility reports every missing help structure", () => {
  assert.deepEqual(missingClaudeHelpStructures("--verbose --allowedTools"), [
    "-p, --print",
    "--output-format <format>",
    "--tools <tools...>",
    "--permission-mode <mode>",
    "--permission-prompts <target>",
    "--session-id <uuid>",
  ]);
});

test("Claude child environment removes provider and retry selectors but preserves unrelated values", () => {
  const env = childEnvironment({
    ANTHROPIC_API_KEY: "paid",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_VERTEX: "1",
    AZURE_CLIENT_SECRET: "secret",
    CLAUDE_CODE_RETRY_WATCHDOG: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    KEEP_ME: "yes",
  }, { ANTHROPIC_AUTH_TOKEN: "dummy" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(env.AZURE_CLIENT_SECRET, undefined);
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, undefined);
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy");
});

test("stream-json parsing rejects empty invalid and partially invalid output", () => {
  assert.throws(() => parseStreamJson("\n"), /no stream-json records/u);
  assert.throws(() => parseStreamJson("not-json\n"), /line 1/u);
  assert.throws(() => parseStreamJson('{"type":"ok"}\nnot-json\n'), /line 2/u);
});

test("final response extraction tolerates nested stream-json envelopes", () => {
  assert.equal(findFinalText([{ type: "result", result: "complete" }], "fallback"), "result\ncomplete");
  assert.equal(findFinalText([], "fallback"), "fallback");
});

test("process error redaction removes bearer values and bounds output", () => {
  const result = redactProcessError(`failure Bearer secret-value ${"x".repeat(2000)}`);
  assert.doesNotMatch(result, /secret-value/u);
  assert.match(result, /Bearer \[redacted\]/u);
  assert.ok(result.length <= 1000);
});
