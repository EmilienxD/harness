import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ABOARD_MCP_TOOLS,
  AGENT_DEFINITION_DIRECTORY,
  BUILTIN_AGENT_NAMES,
  NATIVE_SUBAGENT_TYPES,
  SCAFFOLDED_AGENT_NAMES,
  WORKER_AGENT_NAMES,
  parseAgentDefinition,
  parseBuiltinAgentProfile,
  parseManagerAgentDefinition,
  rewriteAgentTools,
  sanitizeAgentDefinition,
  type WorkerAgentName,
} from "../src/scaffold/agent-definition.js";

const agentsRoot = join(process.cwd(), "assets", "scaffold", ".aboard", "agents");
const taskTools = ["TaskCreate", "TaskGet", "TaskList", "TaskStop", "TaskUpdate", "TodoWrite"] as const;

const expected = {
  brainstormer: {
    capability: "write-capable",
    model: "opus",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Skill"],
  },
  webresearcher: {
    capability: "read-only",
    model: "sonnet",
    effort: "medium",
    tools: ["WebSearch", "WebFetch"],
  },
  // The three roles that are only ever sent at one issue defer both fields to
  // that issue's difficulty label; every other role answers for itself.
  implementer: {
    capability: "write-capable",
    model: "by-difficulty",
    effort: "by-difficulty",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", ...taskTools],
  },
  "pr-doctor-afk": {
    capability: "write-capable",
    model: "by-difficulty",
    effort: "by-difficulty",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill", ...taskTools],
  },
  "pr-doctor-hitl": {
    capability: "write-capable",
    model: "by-difficulty",
    effort: "by-difficulty",
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
    model: "haiku",
    effort: "low",
    command: ["claude"],
  });
  assert.doesNotMatch(source, /^tools\s*:/mu);
  assert.equal(source.replace(/^---\n[\s\S]*?\n---\s*/u, ""), "");

  const configured = parseBuiltinAgentProfile(
    "---\nname: Explore\ndescription: d\nmodel: haiku\neffort: high\ncommand: wrapper run MyProfile --\n---\n",
  );
  assert.deepEqual(configured.ok && configured.value, {
    name: "Explore", description: "d", model: "haiku", effort: "high", command: ["wrapper", "run", "MyProfile", "--"],
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
    assert.equal(agent.model, expected[name].model);
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

test("the rewrite narrows a bare Agent allowance to Claude Code's native types", () => {
  assert.deepEqual(rewriteAgentTools(["Read", "Agent", "Skill"]), [
    "Read",
    ...NATIVE_SUBAGENT_TYPES.map((type) => `Agent(${type})`),
    "Skill",
  ]);
  // Read-the-repository and a fresh full-tool context are the two a worker
  // delegates. The configuration assistants are not granted on spec.
  assert.deepEqual(NATIVE_SUBAGENT_TYPES, ["Explore", "general-purpose"]);
  for (const excluded of ["Plan", "claude-code-guide", "statusline-setup"]) {
    assert.equal(NATIVE_SUBAGENT_TYPES.includes(excluded as never), false, excluded);
  }
  for (const aboardType of [...WORKER_AGENT_NAMES, "manager"]) {
    assert.equal(NATIVE_SUBAGENT_TYPES.includes(aboardType as never), false, `${aboardType} must not be spawnable`);
  }
  // An already-scoped rule is the author's, and a list without `Agent` is
  // untouched.
  assert.deepEqual(rewriteAgentTools(["Agent(Explore)"]), ["Agent(Explore)"]);
  assert.deepEqual(rewriteAgentTools(["WebSearch", "WebFetch"]), ["WebSearch", "WebFetch"]);
});

test("the rewrite copies unresolved frontmatter verbatim, including the color", async () => {
  const source = [
    "---",
    "name: implementer",
    "description: Implement one issue.",
    "tools: Read, Agent",
    "model: opus",
    "effort: high",
    "command: wrapper run MyProfile --",
    "color: pink",
    "maxTurns: 40",
    "hooks:",
    "  PreToolUse:",
    "    - matcher: Bash",
    "---",
    "Implement it.",
  ].join("\n");
  const parsed = parseAgentDefinition(source);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.deepEqual(parsed.ok && parsed.value.extraFrontmatter, [
    "color: pink",
    "maxTurns: 40",
    "hooks:",
    "  PreToolUse:",
    "    - matcher: Bash",
  ]);

  const sanitized = sanitizeAgentDefinition(parsed.ok ? parsed.value : ({} as never));
  assert.deepEqual(sanitized.tools, ["Read", ...NATIVE_SUBAGENT_TYPES.map((type) => `Agent(${type})`)]);
  assert.equal(sanitized.description, "Implement one issue.");
  assert.equal(sanitized.model, "opus");
  assert.equal(sanitized.effort, "high");
  assert.deepEqual(sanitized.command, ["wrapper", "run", "MyProfile", "--"]);
  // Capability is derived from the rewritten list, so the tools the launch
  // grants and the tools the lease reasons about cannot drift apart.
  assert.equal(sanitized.writeCapability, "read-only");

  // Every shipped definition survives the round trip with its capability intact,
  // its color being the only carried-through frontmatter.
  for (const name of WORKER_AGENT_NAMES) {
    const agent = await definition(name);
    assert.equal(sanitizeAgentDefinition(agent).writeCapability, agent.writeCapability, name);
    assert.deepEqual(sanitizeAgentDefinition(agent).extraFrontmatter.map((line) => /^(\w+):/.exec(line)?.[1]), ["color"]);
  }
});

test("the authored definitions declare the fleet colors, carried through rather than resolved", async () => {
  const colors: Record<string, string> = {};
  for (const name of [...WORKER_AGENT_NAMES, "manager"] as const) {
    const source = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    const parsed = name === "manager" ? parseManagerAgentDefinition(source) : parseAgentDefinition(source);
    assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
    const lines = parsed.ok ? parsed.value.extraFrontmatter : [];
    const colorLines = lines.filter((line) => line.startsWith("color:"));
    assert.equal(colorLines.length, 1, `${name} must declare exactly one color line`);
    colors[name] = colorLines[0]!.slice("color:".length).trim();
  }
  // Color is identity in the session UI; two roles sharing one would make the
  // banner ambiguous exactly where it is meant to disambiguate.
  const assigned = Object.values(colors);
  assert.equal(new Set(assigned).size, assigned.length, assigned.join(", "));
  // Explore specifies no color: it launches as Claude Code's builtin, and aboard
  // writes no definition it could color.
  const explore = parseBuiltinAgentProfile(await readFile(join(agentsRoot, "Explore.md"), "utf8"));
  assert.equal(explore.ok, true, explore.ok ? undefined : explore.reason);
});

test("a color a user writes travels verbatim, and a blank one stays one line", () => {
  const parsed = parseAgentDefinition(
    "---\nname: implementer\ndescription: d\ntools: Read\nmodel: opus\ncolor: chartreuse\n---\nImplement.",
  );
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.deepEqual(parsed.ok && parsed.value.extraFrontmatter, ["color: chartreuse"]);

  const blank = parseAgentDefinition(
    "---\nname: implementer\ndescription: d\ntools: Read\nmodel: opus\ncolor:\n---\nImplement.",
  );
  assert.equal(blank.ok, true, blank.ok ? undefined : blank.reason);
  assert.deepEqual(blank.ok && blank.value.extraFrontmatter, ["color:"]);
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
