import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childEnvironment } from "../e2e/smoke.js";
import { harnessWorktreePaths, repositoryFixtureRoot } from "../e2e/repository.js";
import { AFTER_CONTENT, AUTO_RUN_AFK_MARKER, AUTO_RUN_HITL_REVIEW_MARKER, AUTO_RUN_NESTED_CONTEXT, AUTO_RUN_PERMANENT_NOTE, FINAL_RESPONSE, HITL_ACCEPT_PROMPT, SCENARIO_MARKER, ScenarioMismatch, parseMessagesRequest, transition, type Message } from "../e2e/scenario.js";
import { startFakeAnthropicServer } from "../e2e/server.js";
import { startFakeOpenAiServer } from "../e2e/codex-server.js";

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
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_read_target", content: "1→harness e2e fixture: before", is_error: false }] },
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

test("OpenAI emulator drives a real Codex function turn and redacts diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-codex-server-"));
  const diagnosticsPath = join(root, "diagnostics.json");
  const server = await startFakeOpenAiServer({ diagnosticsPath });
  const headers = { authorization: `Bearer ${server.authToken}`, "content-type": "application/json" };
  const base = {
    model: "codex-e2e", stream: true, store: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "[E2E:chatgpt-success] private-prompt" }] }],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
  };
  try {
    const first = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(base) });
    assert.equal(first.status, 200);
    const firstCompleted = completedResponse(await first.text());
    const call = (firstCompleted.output as Record<string, unknown>[])[0]!;
    assert.equal(call.type, "function_call");

    const additionalToolsBody = {
      ...base,
      tools: undefined,
      input: [{ type: "additional_tools", tools: [{ type: "custom", name: "exec" }] }, ...base.input],
    };
    const additionalTools = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(additionalToolsBody),
    });
    assert.equal(additionalTools.status, 200);
    const localCall = (completedResponse(await additionalTools.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(localCall.type, "custom_tool_call");
    assert.equal(localCall.name, "exec");
    assert.match(String(localCall.input), /^\/\/ @exec: \{"yield_time_ms": 120000/u);
    assert.match(String(localCall.input), /tools\.write_stdin/u);
    assert.match(String(localCall.input), /exit_code: result\.exit_code/u);

    const localResult = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...additionalToolsBody,
        input: [...additionalToolsBody.input, localCall, { type: "custom_tool_call_output", call_id: localCall.call_id, output: "Script completed\nOutput: {}" }],
      }),
    });
    assert.equal(localResult.status, 200);
    const localCompleted = completedResponse(await localResult.text());
    assert.equal(((localCompleted.output as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[0]!.text, "Deterministic ChatGPT session completed.");

    const secondBody = {
      ...base,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "generic continuation context" }] },
        call,
        { type: "function_call_output", call_id: call.call_id, output: "Chunk ID: e2e\nProcess exited with code 0" },
      ],
    };
    const second = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(secondBody) });
    assert.equal(second.status, 200);
    const secondCompleted = completedResponse(await second.text());
    assert.equal(((secondCompleted.output as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[0]!.text, "Deterministic ChatGPT session completed.");

    const title = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...base,
        tools: undefined,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) },
        text: { format: { type: "json_schema", name: "generated_thread_title", schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } },
      }),
    });
    assert.equal(title.status, 200);
    const titleCompleted = completedResponse(await title.text());
    assert.equal(((titleCompleted.output as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[0]!.text, '{"title":"Deterministic E2E task"}');

    const toolLessAgentTurn = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...base, tools: undefined, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) } }),
    });
    assert.equal(toolLessAgentTurn.status, 400);

    const rejected = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ ...base, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "private-unknown" }] }] }) });
    assert.equal(rejected.status, 400);
    assert.equal(server.assertions().unexpectedRequests, 2);
    assert.deepEqual(server.assertions().checkpoints, ["attended:tool", "attended:complete", "auxiliary:thread-title"]);
  } finally {
    await server.close();
  }
  const diagnostics = await readFile(diagnosticsPath, "utf8");
  assert.doesNotMatch(diagnostics, /private-prompt|private-unknown|aboard-e2e-/);
  assert.match(diagnostics, /"protocol": "openai-responses"/);
  await rm(root, { recursive: true, force: true });
});

test("OpenAI auto-run preserves its implementer route across history-only continuations", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-codex-auto-run-"));
  const server = await startFakeOpenAiServer({ repoRoot: root });
  const headers = { authorization: `Bearer ${server.authToken}`, "content-type": "application/json" };
  const base = {
    model: "codex-e2e", stream: true, store: false,
    input: [{ type: "additional_tools", tools: [{ type: "custom", name: "exec" }] }, {
      type: "message", role: "user", content: [{
        type: "input_text",
        text: `Address issue. ${AUTO_RUN_AFK_MARKER} ${AUTO_RUN_PERMANENT_NOTE} ${AUTO_RUN_NESTED_CONTEXT}`,
      }],
    }],
  };
  let input = [...base.input] as Record<string, unknown>[];
  try {
    for (const [index, output] of [
      "harness e2e fixture: before\n",
      "",
      JSON.stringify({
        exit_code: 0,
        output: "error: Unable to create 'C:/fixture/.git/packed-refs.lock': Permission denied\n[run/e2e abc1234] Update deterministic fixture\n 1 file changed, 1 insertion(+), 1 deletion(-)",
      }),
    ].entries()) {
      const response = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ ...base, input }) });
      assert.equal(response.status, 200);
      const call = (completedResponse(await response.text()).output as Record<string, unknown>[])[0]!;
      const continuation = { type: "message", role: "developer", content: [{ type: "input_text", text: "generic continuation context" }] };
      input = index === 0
        ? [base.input[0]!, continuation, call, { type: "custom_tool_call_output", call_id: call.call_id, output }]
        : [...input, call, { type: "custom_tool_call_output", call_id: call.call_id, output }];
    }
    const complete = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ ...base, input }) });
    assert.equal(complete.status, 200);
    const message = (completedResponse(await complete.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(((message.content as Record<string, unknown>[])[0]!).text, FINAL_RESPONSE);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI AFK reviewer creates an empty completion commit before reporting approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-codex-review-"));
  const server = await startFakeOpenAiServer({ repoRoot: root });
  const headers = { authorization: `Bearer ${server.authToken}`, "content-type": "application/json" };
  const base = {
    model: "codex-e2e", stream: true, store: false,
    input: [
      { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: `Review pull request. ${AUTO_RUN_PERMANENT_NOTE}` }] },
    ],
  };
  try {
    const first = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(base) });
    assert.equal(first.status, 200);
    const call = (completedResponse(await first.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(call.type, "custom_tool_call");
    assert.match(String(call.input), /git commit --allow-empty -m/u);

    const complete = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...base,
        input: [
          { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
          call,
          { type: "custom_tool_call_output", call_id: call.call_id, output: JSON.stringify({ exit_code: 0, output: "commit created" }) },
        ],
      }),
    });
    assert.equal(complete.status, 200);
    const message = (completedResponse(await complete.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(((message.content as Record<string, unknown>[])[0]!).text, "Review complete; no fixes required.");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI emulator resolves a spilled worker task when launch guidance follows its reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "abd-"));
  const spillDirectory = join(root, "worker-1");
  await mkdir(spillDirectory, { recursive: true });
  const spillPath = join(spillDirectory, "task.md");
  await writeFile(spillPath, "[E2E:chatgpt-implement] address it.\n", "utf8");
  const server = await startFakeOpenAiServer({});
  const headers = { authorization: `Bearer ${server.authToken}`, "content-type": "application/json" };
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "codex-e2e", stream: true, store: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Perform the task described in @${spillPath}.` }] }],
        tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(((completedResponse(await response.text()).output as Record<string, unknown>[])[0]!).type, "function_call");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI HITL reviewer leaves its automated result uncommitted and commits only after user acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "aboard-codex-hitl-review-"));
  const server = await startFakeOpenAiServer({ repoRoot: root });
  const headers = { authorization: `Bearer ${server.authToken}`, "content-type": "application/json" };
  const tools = { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] };
  const base = {
    model: "codex-e2e", stream: true, store: false,
    input: [tools, { type: "message", role: "user", content: [{ type: "input_text", text: `Review ${AUTO_RUN_HITL_REVIEW_MARKER}. Aboard pinned abc..def as the immutable review scope.` }] }],
  };
  try {
    const first = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(base) });
    assert.equal(first.status, 200);
    const readCall = (completedResponse(await first.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(readCall.type, "custom_tool_call");

    const reviewedInput = [
      tools,
      readCall,
      { type: "custom_tool_call_output", call_id: readCall.call_id, output: JSON.stringify({ exit_code: 0, output: AFTER_CONTENT }) },
    ];
    const reviewed = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ ...base, input: reviewedInput }) });
    assert.equal(reviewed.status, 200);
    const reviewMessage = (completedResponse(await reviewed.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(reviewMessage.type, "message");

    const acceptInput = [...reviewedInput, reviewMessage, { type: "message", role: "user", content: [{ type: "input_text", text: HITL_ACCEPT_PROMPT }] }];
    const acceptance = await fetch(`${server.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify({ ...base, input: acceptInput }) });
    assert.equal(acceptance.status, 200);
    const commitCall = (completedResponse(await acceptance.text()).output as Record<string, unknown>[])[0]!;
    assert.equal(commitCall.type, "custom_tool_call");
    assert.match(String(commitCall.input), /git add -A/u);

    const accepted = await fetch(`${server.baseUrl}/responses`, {
      method: "POST", headers,
      body: JSON.stringify({ ...base, input: [...acceptInput, commitCall, { type: "custom_tool_call_output", call_id: commitCall.call_id, output: JSON.stringify({ exit_code: 0, output: "commit created" }) }] }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(((completedResponse(await accepted.text()).output as Record<string, unknown>[])[0]!).type, "message");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function completedResponse(stream: string): Record<string, unknown> {
  const data = stream.split(/\r?\n/u).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const completed = data.find((event) => event.type === "response.completed");
  assert.ok(completed !== undefined);
  return completed.response as Record<string, unknown>;
}

test("smoke child environment clears paid and alternate provider selectors", () => {
  const env = childEnvironment({ ANTHROPIC_API_KEY: "paid", CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "secret", KEEP_ME: "yes" }, { ANTHROPIC_AUTH_TOKEN: "dummy" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy");
});

test("reset cleanup accepts only registered worktrees inside the dedicated runtime root", () => {
  const runtimeRoot = join(tmpdir(), "fixture", "runtime");
  const cloneRoot = join(runtimeRoot, "repository");
  const direct = join(runtimeRoot, "worktrees", "repository-1");
  const nested = join(runtimeRoot, "worktrees", "run_123", "repository");
  const unowned = join(tmpdir(), "fixture", "unowned", "repository");
  const output = `worktree ${cloneRoot.replace(/\\/g, "/")}\nHEAD 1\n\nworktree ${direct.replace(/\\/g, "/")}\nHEAD 2\n\nworktree ${nested.replace(/\\/g, "/")}\nHEAD 3\n`;
  assert.deepEqual(harnessWorktreePaths(output, runtimeRoot, cloneRoot), [direct, nested]);
  assert.throws(
    () => harnessWorktreePaths(`${output}\nworktree ${unowned.replace(/\\/g, "/")}\nHEAD 4\n`, runtimeRoot, cloneRoot),
    /outside the dedicated harness worktree root/u,
  );
  assert.throws(
    () => harnessWorktreePaths(`${output}\nworktree ${join(runtimeRoot, "worktrees").replace(/\\/g, "/")}\nHEAD 4\n`, runtimeRoot, cloneRoot),
    /outside the dedicated harness worktree root/u,
  );
});

test("repository reset resolves the checked-in canonical fixture", async () => {
  assert.equal(await readFile(join(repositoryFixtureRoot, "deterministic.txt"), "utf8"), "harness e2e fixture: before\n");
});
