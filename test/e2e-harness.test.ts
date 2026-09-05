import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childEnvironment } from "../e2e/smoke.js";
import { harnessWorktreePaths } from "../e2e/repository.js";
import { FINAL_RESPONSE, SCENARIO_MARKER, ScenarioMismatch, parseMessagesRequest, transition, type Message } from "../e2e/scenario.js";
import { startFakeAnthropicServer } from "../e2e/server.js";

function request(messages: readonly Message[], stream = false) {
  return parseMessagesRequest({ model: "claude-e2e", max_tokens: 1000, messages, stream, tools: [{ name: "Read" }, { name: "Edit" }], unknown_future_field: true }, true);
}

test("scenario derives Read, Edit, and final response from complete history", () => {
  const root = "C:\\fixture";
  const initial: Message[] = [{ role: "user", content: [{ type: "text", text: `${SCENARIO_MARKER} update it` }] }];
  const read = transition(request(initial), root);
  assert.equal(read.checkpoint, "read-target");
  assert.deepEqual(read, transition(request(initial), root));

  const afterRead: Message[] = [
    ...initial,
    { role: "assistant", content: read.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_read_target", content: "1→aboard e2e fixture: before", is_error: false }] },
  ];
  const edit = transition(request(afterRead), root);
  assert.equal(edit.checkpoint, "edit-target");

  const afterEdit: Message[] = [
    ...afterRead,
    { role: "assistant", content: edit.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_edit_target", content: "The file was updated successfully.", is_error: false }] },
  ];
  const complete = transition(request(afterEdit), root);
  assert.equal(complete.checkpoint, "complete");
  assert.deepEqual(complete.content, [{ type: "text", text: FINAL_RESPONSE }]);
});

test("scenario fails closed on an unknown request history without echoing content", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-secret-id", content: "secret-result" }, { type: "text", text: `${SCENARIO_MARKER} secret-prompt` }] }];
  assert.throws(() => transition(request(messages), "C:\\fixture"), (error: unknown) => {
    assert.ok(error instanceof ScenarioMismatch);
    assert.doesNotMatch(error.message, /secret-prompt|secret-result|unknown-secret-id/);
    assert.match(error.message, /unknown tool_result id hash/);
    return true;
  });
});

test("fake server supports aggregate and streaming responses with redacted diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-e2e-server-"));
  const diagnosticsPath = join(root, "diagnostics.json");
  const server = await startFakeAnthropicServer({ repoRoot: root, diagnosticsPath });
  try {
    const body = { model: "claude-e2e", max_tokens: 1000, messages: [{ role: "user", content: [{ type: "text", text: `${SCENARIO_MARKER} private-prompt` }] }], stream: false, tools: [{ name: "Read" }, { name: "Edit" }] };
    const aggregate = await fetch(`${server.baseUrl}/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json", "x-claude-code-session-id": "private-session-id" }, body: JSON.stringify(body) });
    assert.equal(aggregate.status, 200);
    assert.equal((await aggregate.json() as { stop_reason?: unknown }).stop_reason, "tool_use");

    const streaming = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
    const streamText = await streaming.text();
    assert.deepEqual([...streamText.matchAll(/^event: (.+)$/gm)].map((match) => match[1]), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);

    const hello = await fetch(`${server.baseUrl}/api/hello`, { method: "HEAD" });
    assert.equal(hello.status, 204);
    const tokenCount = await fetch(`${server.baseUrl}/v1/messages/count_tokens`, { method: "POST", headers: { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await tokenCount.json(), { input_tokens: 1000 });

    const unexpectedBody = { ...body, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "private-unknown-id", content: "private-result" }, { type: "text", text: `${SCENARIO_MARKER} private-prompt` }] }] };
    const unexpected = await fetch(`${server.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${server.authToken}`, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(unexpectedBody) });
    assert.equal(unexpected.status, 400);
    assert.match(JSON.stringify(await unexpected.json()), /unknown tool_result id hash/);
    assert.equal(server.assertions().unexpectedRequests, 1);
    assert.equal(server.assertions().tokenCountRequests, 1);
  } finally {
    await server.close();
  }
  const diagnostics = await readFile(diagnosticsPath, "utf8");
  assert.doesNotMatch(diagnostics, /private-prompt|private-session-id|private-result|private-unknown-id|aboard-e2e-/);
  assert.match(diagnostics, /"upstreamMode": "forbidden"/);
  await rm(root, { recursive: true, force: true });
});

test("smoke child environment clears paid and alternate provider selectors", () => {
  const env = childEnvironment({ ANTHROPIC_API_KEY: "paid", CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "secret", KEEP_ME: "yes" }, { ANTHROPIC_AUTH_TOKEN: "dummy" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy");
});

test("reset cleanup accepts only registered worktrees inside the dedicated runtime root", () => {
  const runtimeRoot = "C:\\fixture\\runtime";
  const cloneRoot = `${runtimeRoot}\\repository`;
  const valid = `${runtimeRoot}\\worktrees\\run_123\\repository`;
  const output = `worktree ${cloneRoot.replace(/\\/g, "/")}\nHEAD 1\n\nworktree ${valid.replace(/\\/g, "/")}\nHEAD 2\n`;
  assert.deepEqual(harnessWorktreePaths(output, runtimeRoot, cloneRoot), [valid]);
  assert.throws(
    () => harnessWorktreePaths(`${output}\nworktree C:/fixture/unowned/repository\nHEAD 3\n`, runtimeRoot, cloneRoot),
    /outside the dedicated harness worktree root/u,
  );
});
