import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SCAFFOLDED_AGENT_NAMES,
  WORKER_AGENT_NAMES,
  parseAgentDefinition,
  parseManagerAgentDefinition,
  type WorkerAgentName,
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
  "pr-doctor-afk": {
    capability: "write-capable",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"],
  },
  "pr-doctor-hitl": {
    capability: "write-capable",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", "AskUserQuestion"],
  },
} as const;

async function definition(name: WorkerAgentName) {
  const parsed = parseAgentDefinition(await readFile(join(agentsRoot, `${name}.md`), "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  return parsed.value;
}

test("ships the Manager definition and exactly the four worker definitions", async () => {
  const files = (await readdir(agentsRoot)).sort();
  assert.deepEqual(files, SCAFFOLDED_AGENT_NAMES.map((name) => `${name}.md`).sort());
  assert.equal(files.includes("manager.md"), true);
  assert.equal(files.includes("raw.md"), false);
  assert.equal(files.includes("explorer.md"), false);
});

test("parses every worker definition and derives its capability from the exact tool catalogue", async () => {
  for (const name of WORKER_AGENT_NAMES) {
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
  assert.match(implementer.prompt, /already created and checked out/i);
  assert.match(implementer.prompt, /contract ends at "the working tree contains the change\."/i);
  assert.match(implementer.prompt, /After compaction.*`gh issue view`/is);

  const afk = await definition("pr-doctor-afk");
  assert.match(afk.prompt, /Apply the fixes you find directly/i);
  assert.match(afk.prompt, /becomes the fix commit's body/i);

  const hitl = await definition("pr-doctor-hitl");
  assert.match(hitl.prompt, /Present your findings to the user and stop/i);
  assert.match(hitl.prompt, /only the changes they agreed to/i);
  assert.match(hitl.prompt, /their merge is the approval/i);
});

// The two doctors are the same reviewer with different permission to act, so a
// contract that appears in only one of them is a bug, not a specialization.
test("the pr-doctors forbid git and gh identically and differ only in when they may act", async () => {
  const afk = await definition("pr-doctor-afk");
  const hitl = await definition("pr-doctor-hitl");
  for (const prompt of [afk.prompt, hitl.prompt]) {
    assert.match(prompt, /Do not run `git commit`, `git push`, `git checkout`, or any `gh` command/);
    assert.match(prompt, /do not post review comments or merge anything/i);
    assert.match(prompt, /review and you fix, in the same context/i);
  }
  assert.doesNotMatch(afk.prompt, /AskUserQuestion/);
});

test("the implementer is forbidden every git and GitHub side effect the engine owns", async () => {
  const implementer = await definition("implementer");
  for (const forbidden of ["git commit", "git push", "git checkout", "git branch"]) {
    assert.match(implementer.prompt, new RegExp(`\`${forbidden}\``));
  }
  assert.match(implementer.prompt, /any `gh` command/);
});

test("the Manager definition leaves its tool set to the launch preset", async () => {
  const source = await readFile(join(agentsRoot, "manager.md"), "utf8");
  const parsed = parseManagerAgentDefinition(source);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.equal(parsed.value.model, "opus");
  // Omitting `tools:` is what makes `--agent manager --tools <preset>` a
  // narrowing rather than a contradiction: an agent without the field inherits
  // the full pool. A `tools:` line here would silently compete with the setting.
  assert.doesNotMatch(source, /^tools\s*:/m);

  assert.equal(
    parseManagerAgentDefinition("---\nname: manager\ndescription: d\nmodel: opus\ntools: Read\n---\nOrchestrate.").ok,
    false,
  );
  assert.equal(
    parseManagerAgentDefinition("---\nname: implementer\ndescription: d\nmodel: opus\n---\nOrchestrate.").ok,
    false,
  );
  // The Manager is not a worker: it must not resolve through the worker parser.
  assert.equal(parseAgentDefinition(source).ok, false);
});

test("Manager guidance stays shallow and handles failed slash-command interception", async () => {
  const parsed = parseManagerAgentDefinition(await readFile(join(agentsRoot, "manager.md"), "utf8"));
  assert.equal(parsed.ok, true);
  const manager = parsed.ok ? parsed.value.prompt : "";
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
