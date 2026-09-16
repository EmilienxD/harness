import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AFTER_CONTENT,
  AUTO_RUN_AFK_MARKER,
  AUTO_RUN_EXPLORE_REPORT,
  AUTO_RUN_NESTED_CONTEXT,
  AUTO_RUN_PERMANENT_NOTE,
  AUTO_RUN_FOLLOWUP_MARKER,
  AUTO_RUN_HITL_MARKER,
  AUTO_RUN_HITL_REVIEW_MARKER,
  HITL_ACCEPT_PROMPT,
  BEFORE_CONTENT,
  WORKER_COMMIT_COMMAND,
  parseMessagesRequest,
  transition,
  type Message,
} from "../e2e/scenario.js";

const root = join(tmpdir(), "fixture");

function request(messages: readonly Message[], tools: readonly string[] = ["Read", "Edit", "Bash"]) {
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
      file_path: join(root, "deterministic.txt"),
      old_string: BEFORE_CONTENT.trimEnd(),
      new_string: AFTER_CONTENT.trimEnd(),
      replace_all: false,
    },
  }]);

  const afterEdit: Message[] = [
    ...afterRead,
    { role: "assistant", content: edit.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_afk_edit", content: "updated", is_error: false }] },
  ];
  // The commit is the completion signal, so the worker makes one itself.
  const commit = transition(request(afterEdit), root);
  assert.equal(commit.checkpoint, "auto-afk-commit");
  assert.equal(commit.content[0]?.name, "Bash");
  assert.equal((commit.content[0]?.input as { command?: string }).command, WORKER_COMMIT_COMMAND);

  const complete = transition(request([
    ...afterEdit,
    { role: "assistant", content: commit.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_afk_commit", content: "1 file changed", is_error: false }] },
  ]), root);
  assert.equal(complete.checkpoint, "auto-afk-complete");
  assert.doesNotMatch(String(complete.content[0]?.text), /<commit>/u);
});

test("auto-run Explore reads the checkout before returning bounded context", () => {
  const initial: Message[] = [{ role: "user", content: `<work-to-explore>${AUTO_RUN_AFK_MARKER} ${AUTO_RUN_NESTED_CONTEXT}</work-to-explore>` }];
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

test("auto-run AFK reviewer creates an empty approval commit when no fixes are needed", () => {
  const initial: Message[] = [{ role: "user", content: `Review pull request. ${AUTO_RUN_PERMANENT_NOTE}` }];
  const commit = transition(request(initial, ["Read", "Edit", "Bash"]), root);
  assert.equal(commit.checkpoint, "auto-review-commit");
  assert.equal(commit.content[0]?.name, "Bash");
  assert.equal((commit.content[0]?.input as { command?: string }).command, 'git commit --allow-empty -m "Approve deterministic fixture"');
  const complete = transition(request([
    ...initial,
    { role: "assistant", content: commit.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_review_commit", content: "commit created", is_error: false }] },
  ], ["Read", "Edit", "Bash"]), root);
  assert.equal(complete.checkpoint, "auto-review-complete");
  assert.deepEqual(complete.content, [{ type: "text", text: "Review complete; no fixes required." }]);
});

test("single-branch HITL and follow-up workers apply sequential edits", () => {
  const cases = [
    { marker: AUTO_RUN_HITL_MARKER, readId: "toolu_e2e_auto_hitl_read", editId: "toolu_e2e_auto_hitl_edit", before: "harness e2e fixture: before", after: "harness e2e fixture: after", checkpoint: "auto-hitl" },
    { marker: AUTO_RUN_FOLLOWUP_MARKER, readId: "toolu_e2e_auto_followup_read", editId: "toolu_e2e_auto_followup_edit", before: "harness e2e fixture: after", after: "harness e2e fixture: complete", checkpoint: "auto-followup" },
  ] as const;
  for (const item of cases) {
    const initial: Message[] = [{ role: "user", content: `Address issue. ${item.marker}` }];
    const read = transition(request(initial), root);
    assert.equal(read.checkpoint, `${item.checkpoint}-read`);
    const afterRead: Message[] = [...initial, { role: "assistant", content: read.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: item.readId, content: item.before, is_error: false }] }];
    const edit = transition(request(afterRead), root);
    assert.equal(edit.checkpoint, `${item.checkpoint}-edit`);
    assert.equal((edit.content[0]?.input as { new_string?: string }).new_string, item.after);
    const afterEdit: Message[] = [...afterRead, { role: "assistant", content: edit.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: item.editId, content: "updated", is_error: false }] }];
    if (item.marker === AUTO_RUN_HITL_MARKER) {
      const handoff = transition(request(afterEdit), root);
      assert.equal(handoff.checkpoint, "auto-hitl-handoff");
      assert.equal(handoff.stopReason, "end_turn");
      afterEdit.push({ role: "assistant", content: handoff.content }, { role: "user", content: HITL_ACCEPT_PROMPT });
    }
    const commit = transition(request(afterEdit), root);
    assert.equal(commit.checkpoint, `${item.checkpoint}-commit`);
    const complete = transition(request([...afterEdit, { role: "assistant", content: commit.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: `${item.editId}_commit`, content: "1 file changed", is_error: false }] }]), root);
    assert.equal(complete.checkpoint, `${item.checkpoint}-complete`);
  }
});

test("HITL reviewer inspects the reset implementation without committing, then accepts only on user request", () => {
  const initial: Message[] = [{
    role: "user",
    content: `Review issue #42; Accept deterministic single-branch change after review in the exact range abc..def. Leave the code and any review fixes uncommitted.`,
  }];
  const read = transition(request(initial), root);
  assert.equal(read.checkpoint, "auto-hitl-review-read");
  assert.equal(read.content[0]?.name, "Read");
  const reviewed: Message[] = [
    ...initial,
    { role: "assistant", content: read.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_hitl_review_read", content: AFTER_CONTENT, is_error: false }] },
  ];
  const complete = transition(request(reviewed), root);
  assert.equal(complete.checkpoint, "auto-hitl-review-complete");
  assert.equal(complete.stopReason, "end_turn");

  const acceptance = transition(request([
    ...reviewed,
    { role: "assistant", content: complete.content },
    { role: "user", content: HITL_ACCEPT_PROMPT },
  ]), root);
  assert.equal(acceptance.checkpoint, "auto-hitl-accept-commit");
  assert.equal(acceptance.content[0]?.name, "Bash");
  const accepted = transition(request([
    ...reviewed,
    { role: "assistant", content: complete.content },
    { role: "user", content: HITL_ACCEPT_PROMPT },
    { role: "assistant", content: acceptance.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_auto_hitl_accept_commit", content: "commit created", is_error: false }] },
  ]), root);
  assert.equal(accepted.checkpoint, "auto-hitl-accept-complete");
});
