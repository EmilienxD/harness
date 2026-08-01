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
    // Absent: the brainstormer is the interactive type, so the user's own
    // session level is the right one to keep.
    effort: undefined,
    tools: ["Read", "Grep", "Glob", "Bash(gh *)", "Agent", "Skill", "AskUserQuestion"],
  },
  implementer: {
    capability: "write-capable",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"],
  },
  "pr-doctor-afk": {
    capability: "write-capable",
    effort: "high",
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "LSP", "Agent", "Skill"],
  },
  "pr-doctor-hitl": {
    capability: "write-capable",
    effort: "high",
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
    assert.equal(agent.effort, expected[name].effort);
    assert.deepEqual(agent.tools, expected[name].tools);
    assert.equal(agent.writeCapability, expected[name].capability);
  }
});

/**
 * `--agent` replaces Claude Code's default system prompt entirely
 * (`docs/CLAUDE-REFERENCES/subagents.md`), so each definition body is the whole
 * system prompt and has to carry its own grounding. The shared blocks live in
 * one file each and are embedded verbatim; this is what catches the copies
 * drifting apart.
 */
async function sharedBlock(name: "baseline" | "engineering"): Promise<string> {
  const source = await readFile(join(process.cwd(), "docs", "agent-prompts", `${name}.md`), "utf8");
  // Drop the leading HTML comment: it explains the file to a maintainer and is
  // deliberately not part of what the agents are given.
  return source.slice(source.indexOf("-->") + 3).trim();
}

test("every scaffolded agent embeds the shared baseline verbatim", async () => {
  const baseline = await sharedBlock("baseline");
  const sections = baseline.split("\n\n## ");
  for (const name of SCAFFOLDED_AGENT_NAMES) {
    const body = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    for (const section of sections) {
      const heading = section.split("\n")[0]!.replace(/^## /, "");
      // The brainstormer writes the spec issue with `gh`, so its care section is
      // deliberately its own; every other section must match byte for byte.
      if (name === "brainstormer" && (heading === "Executing actions with care" || heading === "Using your tools")) continue;
      assert.ok(
        body.includes(section.startsWith("## ") ? section : `## ${section}`) || body.includes(section),
        `${name}.md has drifted from the shared baseline section "${heading}"`,
      );
    }
  }
});

test("only the code-writing agents carry the engineering block, and identically", async () => {
  const engineering = await sharedBlock("engineering");
  const body = engineering.slice(engineering.indexOf("## Writing code"));
  for (const name of ["implementer", "pr-doctor-afk", "pr-doctor-hitl"] as const) {
    const definition = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    assert.ok(definition.includes(body), `${name}.md has drifted from the shared engineering block`);
  }
  // The Manager and the brainstormer write no code; a page of comment policy
  // would only crowd out the guidance they do need.
  for (const name of ["manager", "brainstormer"] as const) {
    const definition = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    assert.equal(definition.includes("## Writing code"), false, `${name}.md should not carry the engineering block`);
  }
});

// The whole point of the rewrite: a definition body is the entire system prompt,
// so a definition that fits in a paragraph is an agent running on nothing.
test("every definition body is substantial enough to stand in for a system prompt", async () => {
  for (const name of SCAFFOLDED_AGENT_NAMES) {
    const body = await readFile(join(agentsRoot, `${name}.md`), "utf8");
    const prompt = body.slice(body.indexOf("---", 3) + 3).trim();
    assert.ok(prompt.length > 3_000, `${name}.md body is only ${prompt.length} chars`);
  }
});

test("worker prompts encode their product contracts", async () => {
  const brainstormer = await definition("brainstormer");
  assert.match(brainstormer.prompt, /one decision at a time/i);
  assert.match(brainstormer.prompt, /recommended answer/i);
  assert.match(brainstormer.prompt, /`spec` label/);
  assert.match(brainstormer.prompt, /do not .*modify any workspace file/i);

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

test("the Manager definition declares the read-only tool list, with no Agent or session-task tools", async () => {
  const source = await readFile(join(agentsRoot, "manager.md"), "utf8");
  const parsed = parseManagerAgentDefinition(source);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
  assert.equal(parsed.value.model, "opus");
  // The Manager is told to stay shallow and spend at most one short turn
  // deciding how to delegate, so it runs below the workers it dispatches.
  assert.equal(parsed.value.effort, "medium");
  // The frontmatter allowlist is the Manager's only tool authority: the
  // command line carries no --tools (spec section 5.1.1). `Agent` and the
  // session-task tools are absent from it, not merely denied (spec section 4.3).
  assert.deepEqual(parsed.value.tools, ["mcp__aboard__*", "Read", "Grep", "Glob", "Bash", "Skill", "AskUserQuestion"]);
  for (const forbidden of ["Agent", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TodoWrite"]) {
    assert.equal(parsed.value.tools.includes(forbidden), false, `${forbidden} must be absent`);
  }
  // Unrestricted Bash keeps the Manager write-capable on paper (spec section
  // 4.3.1); it never holds the lease because requiresWriteLease exempts the type.
  assert.equal(parsed.value.writeCapability, "write-capable");

  // Without `tools:` the Manager would inherit the full pool, Agent included.
  assert.equal(
    parseManagerAgentDefinition("---\nname: manager\ndescription: d\nmodel: opus\n---\nOrchestrate.").ok,
    false,
  );
  assert.equal(
    parseManagerAgentDefinition("---\nname: implementer\ndescription: d\nmodel: opus\ntools: Read\n---\nOrchestrate.").ok,
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
    // Interception failure is compressed to one line rather than a paragraph:
    // it is an aboard bug the hook already reports, and a paragraph about it
    // taxed every turn to defend against a case the user sees anyway.
    /bare slash command.*interception failed/is,
    /rather than improvising the action yourself/i,
    // The state block is the Manager's orientation; it must be told to use it
    // instead of re-fetching what it already holds.
    /<aboard-state>/,
  ]) {
    assert.match(manager, required);
  }
});

test("an agent definition may declare an effort level, and an unknown one is refused", () => {
  const worker = (frontmatter: string) =>
    parseAgentDefinition(`---\nname: implementer\ndescription: d\ntools: Read\nmodel: opus\n${frontmatter}---\nImplement.`);

  // Absent is the documented "inherit the session level", so it parses and
  // leaves the field unset rather than inventing a default.
  const inherited = worker("");
  assert.equal(inherited.ok, true, inherited.ok ? undefined : inherited.reason);
  assert.equal(inherited.ok && inherited.value.effort, undefined);

  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    const parsed = worker(`effort: ${level}\n`);
    assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.reason);
    assert.equal(parsed.ok && parsed.value.effort, level);
  }
  // Claude Code refuses the launch outright on an unknown level, so a typo is
  // caught here rather than as a terminal that dies on start.
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
  assert.equal(parseAgentDefinition("---\nname: raw\ndescription: no\ntools: Read\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\nmodel: opus\n---\nNo.").ok, false);
  assert.equal(parseAgentDefinition("---\nname: reviewer\ndescription: no\ntools: Read\nmodel: future\n---\nNo.").ok, false);
});
