import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SCAFFOLDED_AGENT_NAMES,
  parseAgentDefinition,
  type ScaffoldedAgentName,
} from "../src/scaffold/agent-definition.js";

const scaffoldRoot = join(process.cwd(), "assets", "scaffold");
const agentsRoot = join(scaffoldRoot, ".claude", "agents");

const expected = {
  brainstormer: {
    capability: "read-only",
    tools: ["Read", "Grep", "Glob", "Bash(gh *)", "Agent", "Skill", "AskUserQuestion"],
  },
  implementer: {
    capability: "write-capable",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"],
  },
  reviewer: {
    capability: "read-only",
    tools: ["Read", "Grep", "Glob", "Bash(gh *)", "Bash(git diff*)", "LSP"],
  },
  fixer: {
    capability: "write-capable",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"],
  },
} as const;

async function definition(name: ScaffoldedAgentName) {
  const parsed = parseAgentDefinition(await readFile(join(agentsRoot, `${name}.md`), "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  return parsed.value;
}

test("ships exactly the four aboard agent definitions", async () => {
  const files = (await readdir(agentsRoot)).sort();
  assert.deepEqual(files, SCAFFOLDED_AGENT_NAMES.map((name) => `${name}.md`).sort());
  assert.equal(files.includes("manager.md"), false);
  assert.equal(files.includes("raw.md"), false);
  assert.equal(files.includes("explorer.md"), false);
});

test("parses every definition and derives its capability from the exact tool catalogue", async () => {
  for (const name of SCAFFOLDED_AGENT_NAMES) {
    const agent = await definition(name);
    assert.equal(agent.name, name);
    assert.equal(agent.model, "opus");
    assert.deepEqual(agent.tools, expected[name].tools);
    assert.equal(agent.writeCapability, expected[name].capability);
  }
});

test("worker prompts encode their product contracts", async () => {
  const brainstormer = await definition("brainstormer");
  assert.match(brainstormer.prompt, /one decision at a time/i);
  assert.match(brainstormer.prompt, /recommended answer/i);
  assert.match(brainstormer.prompt, /`spec` label/);
  assert.match(brainstormer.prompt, /do not create or modify workspace files/i);

  const implementer = await definition("implementer");
  assert.match(implementer.prompt, /dedicated issue branch/i);
  assert.match(implementer.prompt, /commit and a clean working tree/i);
  assert.match(implementer.prompt, /For an `afk` issue, merge/i);
  assert.match(implementer.prompt, /For a `hitl` issue.*only a human may merge/is);
  assert.match(implementer.prompt, /After compaction.*`gh issue view`/is);

  const reviewer = await definition("reviewer");
  assert.match(reviewer.prompt, /automated review is opt-in/i);
  assert.match(reviewer.prompt, /specific changed lines/i);
  assert.match(reviewer.prompt, /Do not edit code/i);
  assert.match(reviewer.prompt, /GitHub is the durable review record/i);

  const fixer = await definition("fixer");
  assert.match(fixer.prompt, /Reply to every thread/i);
  assert.match(fixer.prompt, /commit and a clean working tree/i);
  assert.match(fixer.prompt, /For `afk`, merge/i);
  assert.match(fixer.prompt, /For `hitl`.*only a human may merge/is);
});

test("Manager guidance stays shallow and handles failed slash-command interception", async () => {
  const manager = await readFile(join(scaffoldRoot, "CLAUDE.md"), "utf8");
  for (const required of [
    /orchestrate/i,
    /not an autonomous software factory/i,
    /Do not implement/i,
    /Do not read large files/i,
    /one short turn deciding how to delegate/i,
    /Never use Claude Code's `Agent` tool/i,
    /session task\/TodoWrite tools/i,
    /bare slash-command text.*command interception failed/is,
    /Do not treat that text as work/i,
  ]) {
    assert.match(manager, required);
  }
});

test("rejects definitions outside the aboard catalogue or without required frontmatter", () => {
  assert.equal(parseAgentDefinition("---\nname: raw\ndescription: no\ntools: Read\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\ntools: Read\nmodel: future\n---\nNo.").ok, false);
});
