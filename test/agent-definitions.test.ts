import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ABOARD_MCP_TOOLS,
  AGENT_DEFINITION_DIRECTORY,
  BUILTIN_AGENT_NAMES,
  SCAFFOLDED_AGENT_NAMES,
  WORKER_AGENT_NAMES,
  parseAgentDefinition,
  parseBuiltinAgentProfile,
  parseManagerAgentDefinition,
  type WorkerAgentName,
} from "../src/scaffold/agent-definition.js";

// Deliberately not under `.claude/agents/`: a definition there is a registered
// subagent type that every session in the workspace can see and spawn — the
// user's own `claude` included — which would put aboard agents outside the
// bridge and outside the write lease. aboard launches these by flag instead, so
// nothing discovers them.
const agentsRoot = join(process.cwd(), "assets", "scaffold", ".aboard", "agents");
const taskTools = ["TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskUpdate", "TodoWrite"] as const;

const expected = {
  brainstormer: {
    capability: "write-capable",
    effort: undefined,
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Skill"],
  },
  webresearcher: {
    capability: "read-only",
    effort: "high",
    tools: ["WebSearch", "WebFetch"],
  },
  implementer: {
    capability: "write-capable",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", ...taskTools],
  },
  "pr-doctor-afk": {
    capability: "write-capable",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", ...taskTools],
  },
  "pr-doctor-hitl": {
    capability: "write-capable",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", ...taskTools],
  },
} as const;

async function definition(name: WorkerAgentName) {
  const parsed = parseAgentDefinition(await readFile(join(agentsRoot, `${name}.md`), "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  return parsed.value;
}

test("ships the Manager, five complete worker definitions, and the Explore builtin profile", async () => {
  const files = (await readdir(agentsRoot)).sort();
  assert.deepEqual(files, SCAFFOLDED_AGENT_NAMES.map((name) => `${name}.md`).sort());
  assert.equal(files.includes("manager.md"), true);
  assert.equal(files.includes("webresearcher.md"), true);
  assert.equal(files.includes("Explore.md"), true);
  assert.equal(files.includes("general-purpose.md"), false);
  assert.equal(files.includes("explorer.md"), false);
});

test("the Explore profile configures launch policy without copying Claude's prompt or tools", async () => {
  assert.deepEqual(BUILTIN_AGENT_NAMES, ["Explore"]);
  const source = await readFile(join(agentsRoot, "Explore.md"), "utf8");
  const parsed = parseBuiltinAgentProfile(source);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.deepEqual(parsed.ok && parsed.value, {
    name: "Explore",
    description: "Claude Code's built-in read-only codebase exploration agent",
    model: "inherit",
  });
  assert.doesNotMatch(source, /^tools\s*:/mu);
  assert.equal(source.replace(/^---\n[\s\S]*?\n---\s*/u, ""), "");

  const configured = parseBuiltinAgentProfile(
    "---\nname: Explore\ndescription: d\nmodel: haiku\neffort: high\ncommand: clauder run kiro --\n---\n",
  );
  assert.deepEqual(configured.ok && configured.value, {
    name: "Explore", description: "d", model: "haiku", effort: "high", command: ["clauder", "run", "kiro", "--"],
  });

  for (const invalid of [
    "---\nname: Explore\ndescription: d\nmodel: inherit\ntools: Read, Grep\n---\n",
    "---\nname: Explore\ndescription: d\nmodel: inherit\n---\nYou are a copied Explore prompt.",
  ]) {
    assert.equal(parseBuiltinAgentProfile(invalid).ok, false);
  }
});

test("parses every worker definition and derives capability from its exact tools", async () => {
  for (const name of WORKER_AGENT_NAMES) {
    const agent = await definition(name);
    assert.equal(agent.name, name);
    assert.equal(agent.model, "opus");
    assert.equal(agent.effort, expected[name].effort);
    assert.deepEqual(agent.tools, expected[name].tools);
    assert.equal(agent.writeCapability, expected[name].capability);
    assert.ok(agent.prompt.length > 1_000, `${name}.md must carry a complete system prompt`);
  }
});

test("the Manager definition declares its orchestration tool list", async () => {
  const source = await readFile(join(agentsRoot, "manager.md"), "utf8");
  const parsed = parseManagerAgentDefinition(source);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.equal(parsed.value.model, "opus");
  assert.equal(parsed.value.effort, "medium");
  assert.deepEqual(parsed.value.tools, ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Skill"]);
  for (const forbidden of ["Agent", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite", "Edit", "Write"]) {
    assert.equal(parsed.value.tools.includes(forbidden), false, `${forbidden} must be absent`);
  }
  // Unrestricted Bash is a residual write vector. Manager launches are exempt
  // from the lease because a permanent Manager lease would deadlock all workers.
  assert.equal(parsed.value.writeCapability, "write-capable");

  assert.equal(parseManagerAgentDefinition("---\nname: manager\ndescription: d\nmodel: opus\n---\nOrchestrate.").ok, false);
  assert.equal(parseManagerAgentDefinition("---\nname: implementer\ndescription: d\nmodel: opus\ntools: Read\n---\nOrchestrate.").ok, false);
  assert.equal(parseAgentDefinition(source).ok, false);
});

test("an agent definition may declare an effort level, and an unknown one is refused", () => {
  const worker = (frontmatter: string) =>
    parseAgentDefinition(`---\nname: implementer\ndescription: d\ntools: Read\nmodel: opus\n${frontmatter}---\nImplement.`);

  const inherited = worker("");
  assert.equal(inherited.ok, true, inherited.ok ? undefined : inherited.reason);
  assert.equal(inherited.ok && inherited.value.effort, undefined);

  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const parsed = worker(`effort: ${level}\n`);
    assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
    assert.equal(parsed.ok && parsed.value.effort, level);
  }
  for (const invalid of ["ultracode", "highest", "opus"]) {
    assert.equal(worker(`effort: ${invalid}\n`).ok, false, `${invalid} must be refused`);
  }

  const manager = parseManagerAgentDefinition(
    "---\nname: manager\ndescription: d\ntools: Read\nmodel: opus\neffort: medium\n---\nOrchestrate.",
  );
  assert.equal(manager.ok && manager.value.effort, "medium");
  assert.equal(
    parseManagerAgentDefinition("---\nname: manager\ndescription: d\ntools: Read\nmodel: opus\neffort: highest\n---\nOrchestrate.").ok,
    false,
  );
});

test("rejects definitions outside the aboard catalogue or without required frontmatter", () => {
  assert.equal(parseAgentDefinition("---\nname: general-purpose\ndescription: no\ntools: Read\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\ntools: Read\nmodel: future\n---\nNo.").ok, false);
});

test("only the Manager's definition admits the aboard MCP tools", async () => {
  const manager = await readFile(join(agentsRoot, "manager.md"), "utf8");
  const parsedManager = parseManagerAgentDefinition(manager);
  assert.equal(parsedManager.ok, true);
  assert.equal(parsedManager.ok && parsedManager.value.tools.includes(ABOARD_MCP_TOOLS), true);

  for (const name of WORKER_AGENT_NAMES) {
    const source = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    const parsed = parseAgentDefinition(source);
    assert.equal(parsed.ok, true, `${name} must parse`);
    assert.equal(source.includes("ABOARD_CLI"), false);
    assert.equal(
      parsed.ok && parsed.value.tools.some((rule) => rule.includes("mcp__aboard")),
      false,
      `${name} must not admit Manager orchestration tools`,
    );
  }

  assert.equal(ABOARD_MCP_TOOLS, "mcp__aboard__*");
  assert.equal(AGENT_DEFINITION_DIRECTORY, ".aboard/agents");
});
