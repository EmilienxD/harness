import assert from "node:assert/strict";
import test from "node:test";

import { runMidPromptSkillsJourney } from "../tools/mid-prompt-skills/run.js";

test("mid-prompt-skills loads skills the real Claude CLI leaves unexpanded, without repeating expanded ones", async () => {
  const result = await runMidPromptSkillsJourney();
  assert.deepEqual(result.checkpoints, ["mid-prompt-skill", "leading-and-later-skill"]);
  assert.deepEqual(result.finalTexts, ["Skill instructions received.", "Skill instructions received."]);
  assert.equal(result.unexpectedRequests, 0);
});
