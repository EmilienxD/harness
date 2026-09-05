import assert from "node:assert/strict";
import test from "node:test";
import {
  BEFORE_CONTENT,
  EXPLORE_REPORT,
  EXPLORE_SCENARIO_MARKER,
  MANAGER_DELEGATION_RESULT,
  MANAGER_SCENARIO_MARKER,
  parseMessagesRequest,
  transition,
  type Message,
} from "../e2e/scenario.js";

const root = "C:\\fixture";

function request(messages: readonly Message[], tools: readonly string[]) {
  return parseMessagesRequest({ model: "claude-e2e", max_tokens: 1000, messages, stream: true, tools: tools.map((name) => ({ name })) }, true);
}

test("Manager scenario delegates a foreground Explore and finishes from its returned report", () => {
  const initial: Message[] = [{ role: "user", content: [{ type: "text", text: `${MANAGER_SCENARIO_MARKER} inspect it` }] }];
  const delegated = transition(request(initial, ["mcp__aboard__run_agent"]), root);
  assert.equal(delegated.scenario, "manager-foreground-explore");
  assert.equal(delegated.checkpoint, "delegate-explore");
  assert.deepEqual(delegated.content, [{
    type: "tool_use",
    id: "toolu_e2e_manager_delegate",
    name: "mcp__aboard__run_agent",
    input: {
      type: "Explore",
      prompt: `${EXPLORE_SCENARIO_MARKER} Read deterministic.txt and report its exact fixture state.`,
      description: "inspect the deterministic fixture",
    },
  }]);

  const returned: Message[] = [
    ...initial,
    { role: "assistant", content: delegated.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_manager_delegate", content: EXPLORE_REPORT, is_error: false }] },
  ];
  const complete = transition(request(returned, ["mcp__aboard__run_agent"]), root);
  assert.equal(complete.checkpoint, "manager-complete");
  assert.deepEqual(complete.content, [{ type: "text", text: MANAGER_DELEGATION_RESULT }]);
});

test("Explore scenario uses the real Read result before reporting completion", () => {
  const initial: Message[] = [{ role: "user", content: [{ type: "text", text: EXPLORE_SCENARIO_MARKER }] }];
  const read = transition(request(initial, ["Read"]), root);
  assert.equal(read.scenario, "explore-read-report");
  assert.equal(read.checkpoint, "explore-read");
  assert.deepEqual(read.content, [{ type: "tool_use", id: "toolu_e2e_explore_read", name: "Read", input: { file_path: "C:\\fixture\\deterministic.txt" } }]);

  const complete = transition(request([
    ...initial,
    { role: "assistant", content: read.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e_explore_read", content: `1→${BEFORE_CONTENT}`, is_error: false }] },
  ], ["Read"]), root);
  assert.equal(complete.checkpoint, "explore-complete");
  assert.deepEqual(complete.content, [{ type: "text", text: EXPLORE_REPORT }]);
});

test("concurrent scenario histories remain independently deterministic", () => {
  const manager = request([{ role: "user", content: MANAGER_SCENARIO_MARKER }], ["mcp__aboard__run_agent"]);
  const explore = request([{ role: "user", content: EXPLORE_SCENARIO_MARKER }], ["Read"]);
  assert.deepEqual(transition(manager, root), transition(manager, root));
  assert.deepEqual(transition(explore, root), transition(explore, root));
  assert.notEqual(transition(manager, root).messageId, transition(explore, root).messageId);
});
