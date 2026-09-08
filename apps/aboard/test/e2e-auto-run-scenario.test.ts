import assert from "node:assert/strict";
import test from "node:test";

import {
  AFTER_CONTENT,
  AUTO_RUN_AFK_MARKER,
  AUTO_RUN_EXPLORE_REPORT,
  AUTO_RUN_NESTED_CONTEXT,
  AUTO_RUN_PERMANENT_NOTE,
  AUTO_RUN_FOLLOWUP_MARKER,
  AUTO_RUN_HITL_MARKER,
  BEFORE_CONTENT,
  parseMessagesRequest,
  transition,
  type Message,
} from "../e2e/scenario.js";

const root = "C:\\fixture";

function request(messages: readonly Message[], tools: readonly string[] = ["Read", "Edit"]) {
  return parseMessagesRequest({
    model: "claude-e2e",
    max_tokens: 1000,
    messages,
    stream: true,
    tools: tools.map((name) => ({ name })),
  }, true);
}

test("auto-run AFK implementer reads, edits, and reports a valid completion", () => {
  const initial: Message[] = [{ role: "user", content: `Address issue. ${AUTO_RUN_AFK_MARKER} ${AUTO_RUN_PERMANENT_NOTE} ${AUTO_RUN_NESTED_CONTEXT}` }];
  const read = transition(request(initial), root);
  assert.equal(read.scenario, "auto-run-afk");
  assert.equal(read.checkpoint, "auto-afk-read");

  const afterRead: Message[] = [
    ...initial,
    { role: "assistant", content: read.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_afk_read", content: `1→${BEFORE_CONTENT}`, is_error: false }] },
  ];
  const edit = transition(request(afterRead), root);
  assert.equal(edit.checkpoint, "auto-afk-edit");
  assert.deepEqual(edit.content, [{
    type: "tool_use",
    id: "toolu_e2e_auto_afk_edit",
    name: "Edit",
    input: {
      file_path: "C:\\fixture\\deterministic.txt",
      old_string: BEFORE_CONTENT.trimEnd(),
      new_string: AFTER_CONTENT.trimEnd(),
      replace_all: false,
    },
  }]);

  const complete = transition(request([
    ...afterRead,
    { role: "assistant", content: edit.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_afk_edit", content: "updated", is_error: false }] },
  ]), root);
  assert.equal(complete.checkpoint, "auto-afk-complete");
  assert.match(String(complete.content[0]?.text), /<commit>Update deterministic fixture<\/commit>/u);
});

test("auto-run Explore reads the checkout before returning bounded context", () => {
  const initial: Message[] = [{ role: "user", content: `Explore implementation context. ${AUTO_RUN_AFK_MARKER} ${AUTO_RUN_NESTED_CONTEXT}` }];
  const read = transition(request(initial, ["Read"]), root);
  assert.equal(read.checkpoint, "auto-explore-read");
  const complete = transition(request([
    ...initial,
    { role: "assistant", content: read.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_explore_read", content: `1→${BEFORE_CONTENT}`, is_error: false }] },
  ], ["Read"]), root);
  assert.equal(complete.checkpoint, "auto-explore-complete");
  assert.deepEqual(complete.content, [{ type: "text", text: AUTO_RUN_EXPLORE_REPORT }]);
});

test("auto-run AFK reviewer completes without changing the accepted diff", () => {
  const initial: Message[] = [{ role: "user", content: `Review pull request. ${AUTO_RUN_PERMANENT_NOTE}` }];
  const complete = transition(request(initial, ["Read", "Edit"]), root);
  assert.equal(complete.checkpoint, "auto-review-complete");
  assert.deepEqual(complete.content, [{ type: "text", text: "Review complete; no fixes required." }]);
});

test("single-branch HITL and follow-up workers apply sequential edits", () => {
  const cases = [
    { marker: AUTO_RUN_HITL_MARKER, readId: "toolu_e2e_auto_hitl_read", editId: "toolu_e2e_auto_hitl_edit", before: "aboard e2e fixture: before", after: "aboard e2e fixture: after", checkpoint: "auto-hitl" },
    { marker: AUTO_RUN_FOLLOWUP_MARKER, readId: "toolu_e2e_auto_followup_read", editId: "toolu_e2e_auto_followup_edit", before: "aboard e2e fixture: after", after: "aboard e2e fixture: complete", checkpoint: "auto-followup" },
  ] as const;
  for (const item of cases) {
    const initial: Message[] = [{ role: "user", content: `Address issue. ${item.marker}` }];
    const read = transition(request(initial), root);
    assert.equal(read.checkpoint, `${item.checkpoint}-read`);
    const afterRead: Message[] = [...initial, { role: "assistant", content: read.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: item.readId, content: item.before, is_error: false }] }];
    const edit = transition(request(afterRead), root);
    assert.equal(edit.checkpoint, `${item.checkpoint}-edit`);
    assert.equal((edit.content[0]?.input as { new_string?: string }).new_string, item.after);
    const complete = transition(request([...afterRead, { role: "assistant", content: edit.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: item.editId, content: "updated", is_error: false }] }]), root);
    assert.equal(complete.checkpoint, `${item.checkpoint}-complete`);
  }
});
