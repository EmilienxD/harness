import assert from "node:assert/strict";
import test from "node:test";
import { AFTER_CONTENT, BEFORE_CONTENT, SCENARIO_MARKER, ScenarioMismatch, parseMessagesRequest, transition, type Message } from "../e2e/scenario.js";

const root = "C:\\fixture";

function request(messages: readonly Message[], tools: readonly string[] = ["Read", "Edit"]) {
  return parseMessagesRequest({
    model: "claude-e2e",
    max_tokens: 1000,
    messages,
    stream: true,
    tools: tools.map((name) => ({ name, future: "accepted" })),
    future_request_field: { accepted: true },
  }, true);
}

function initial(text = `${SCENARIO_MARKER} update it`): Message[] {
  return [{ role: "user", content: [{ type: "text", text, future_block_field: true }] }];
}

function afterRead(content: unknown = `1→${BEFORE_CONTENT}`): Message[] {
  const messages = initial();
  const read = transition(request(messages), root);
  return [...messages, { role: "assistant", content: read.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_read_target", content, is_error: false }] }];
}

function afterEdit(): Message[] {
  const messages = afterRead();
  const edit = transition(request(messages), root);
  return [...messages, { role: "assistant", content: edit.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_edit_target", content: "updated", is_error: false }] }];
}

function mismatch(messages: readonly Message[], pattern: RegExp, tools?: readonly string[]): void {
  assert.throws(() => transition(request(messages, tools), root), (error: unknown) => {
    assert.ok(error instanceof ScenarioMismatch);
    assert.match(error.message, pattern);
    return true;
  });
}

test("scenario selection requires exactly one known marker", () => {
  mismatch(initial("no marker"), /exactly one scenario marker; found 0/u);
  mismatch(initial(`${SCENARIO_MARKER} ${SCENARIO_MARKER}`), /found 2/u);
});

test("identical complete histories produce identical message and tool ids", () => {
  const first = transition(request(initial()), root);
  const second = transition(request(initial()), root);
  assert.deepEqual(first, second);
  assert.deepEqual(transition(request(afterEdit()), root), transition(request(afterEdit()), root));
});

test("unknown request fields roles block fields headers and beta names remain forward compatible", () => {
  const messages = initial();
  messages.splice(0, 0, { role: "system", content: "future system insertion", future: true });
  assert.equal(transition(request(messages), root).checkpoint, "read-target");
});

test("required Read or Edit tool absence fails closed", () => {
  mismatch(initial(), /required tool Read is unavailable/u, ["Edit"]);
  mismatch(afterRead(), /required tool Edit is unavailable/u, ["Read"]);
});

test("duplicate and unknown tool_use ids fail closed", () => {
  const read = transition(request(initial()), root).content[0]!;
  mismatch([...initial(), { role: "assistant", content: [read, read] }], /duplicate tool_use id hash/u);
  mismatch([...initial(), { role: "assistant", content: [{ type: "tool_use", id: "secret-id", name: "Read", input: {} }] }], /unknown tool_use id hash/u);
});

test("duplicate and unknown tool_result ids fail closed", () => {
  const messages = afterRead();
  const result = (messages.at(-1)!.content as readonly unknown[])[0]!;
  mismatch([...messages.slice(0, -1), { role: "user", content: [result, result] }], /duplicate tool_result id hash/u);
  mismatch([...initial(), { role: "user", content: [{ type: "tool_result", tool_use_id: "secret-id", content: "secret" }] }], /unknown tool_result id hash/u);
});

test("mismatched tool name and Edit before successful Read fail closed", () => {
  mismatch([...initial(), { role: "assistant", content: [{ type: "tool_use", id: "toolu_e2e_read_target", name: "Edit", input: {} }] }], /unexpected tool name/u);
  mismatch([...initial(), { role: "assistant", content: [{ type: "tool_use", id: "toolu_e2e_edit_target", name: "Edit", input: {} }] }], /Edit tool_use must follow the Read tool_result/u);
});

test("tool_result must immediately follow its assistant tool_use", () => {
  const messages = afterRead();
  messages.splice(messages.length - 1, 0, { role: "system", content: "interposed" });
  mismatch(messages, /must immediately follow/u);
});

test("user tool_result blocks must precede text", () => {
  assert.throws(() => request([{ role: "user", content: [{ type: "text", text: SCENARIO_MARKER }, { type: "tool_result", tool_use_id: "toolu_e2e_read_target", content: BEFORE_CONTENT }] }]), /must precede text/u);
});

test("failed Read and failed Edit results fail closed", () => {
  const readFailure = afterRead();
  (readFailure.at(-1)!.content as { is_error: boolean }[])[0]!.is_error = true;
  mismatch(readFailure, /Read tool_result reported an error/u);
  const editFailure = afterEdit();
  (editFailure.at(-1)!.content as { is_error: boolean }[])[0]!.is_error = true;
  mismatch(editFailure, /Edit tool_result reported an error/u);
});

test("Read result requires the fixture marker and accepts text-block-array content", () => {
  mismatch(afterRead("unrelated"), /did not contain the expected fixture marker/u);
  assert.equal(transition(request(afterRead([{ type: "text", text: BEFORE_CONTENT }])), root).checkpoint, "edit-target");
});

test("fixture tool paths remain inside the resolved repository root", () => {
  const read = transition(request(initial()), root).content[0] as { input: { file_path: string } };
  assert.equal(read.input.file_path, "C:\\fixture\\deterministic.txt");
  const edit = transition(request(afterRead()), root).content[0] as { input: { old_string: string; new_string: string } };
  assert.equal(edit.input.old_string, BEFORE_CONTENT.trimEnd());
  assert.equal(edit.input.new_string, AFTER_CONTENT.trimEnd());
});

test("unknown histories never echo prompt result input raw id or response content", () => {
  const secrets = ["private-prompt", "private-result", "private-input", "private-id"];
  const messages: Message[] = [{ role: "user", content: [
    { type: "tool_result", tool_use_id: secrets[3], content: secrets[1] },
    { type: "text", text: `${SCENARIO_MARKER} ${secrets[0]}`, input: secrets[2] },
  ] }];
  assert.throws(() => transition(request(messages), root), (error: unknown) => {
    assert.ok(error instanceof ScenarioMismatch);
    for (const secret of secrets) assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});
