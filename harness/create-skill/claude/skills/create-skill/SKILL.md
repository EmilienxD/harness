---
name: create-skill
description:  Create AI Agent Skills for Claude and/or ChatGPT/Codex. Use when authoring a new skill, optimizing an existing skill, or asking about SKILL.md structure and best practices.
disable-model-invocation: true
---

This skill guides you through creating highly effective, optimized Agent Skills. Skills are markdown files (plus optional supporting files) that teach the agent how to perform specific tasks.

## Before You Begin: Gather Requirements

Before creating a skill, gather essential information from the user:
1. **Purpose and scope**: What specific task or workflow should this skill help with?
2. **Target provider(s)**: Claude, ChatGPT/Codex, or Both? If the user doesn't specify, **default to Both** — author the skill so it works unmodified in either agent (see Provider Compatibility below).
3. **Trigger**: Should this be Model-Invoked (auto-applied) or User-Invoked (manual)?
4. **Key domain knowledge**: What specialized information does the agent need?
5. **Target location**: Personal/user-level or project-level? (see Provider Compatibility for the exact paths per provider)

*Note: If the user includes exact wording to use in the skill, respect it and use it **verbatim** in `SKILL.md`. Do not paraphrase or expand their copy.*

---

## Provider Compatibility

The process for designing a skill (steps, references, steering, pruning) is **provider-agnostic** — good prompt engineering doesn't change based on who's running the skill. What *does* change between Claude and ChatGPT/Codex is packaging: where files live, and how the invocation toggle is expressed. Handle this at the end of Phase 1 and throughout Phase 2 by writing the skill to the location(s)/format(s) the target provider(s) need.

| Aspect | Claude (Claude Code / claude.ai) | ChatGPT / Codex |
|---|---|---|
| Core file | `SKILL.md` with `name` + `description` in YAML frontmatter | Identical: `SKILL.md` with `name` + `description` in YAML frontmatter |
| Disable auto-trigger (User-Invoked) | Add `disable-model-invocation: true` to `SKILL.md` frontmatter | Add a sibling `agents/openai.yaml` with `policy.allow_implicit_invocation: false` (frontmatter has no equivalent field) |
| Project-level location | `.claude/skills/<skill-name>/SKILL.md` | `.agents/skills/<skill-name>/SKILL.md` (Codex scans this from cwd up to the repo root) |
| Personal/user-level location | `~/.claude/skills/<skill-name>/SKILL.md` | `~/.agents/skills/<skill-name>/SKILL.md` |
| Optional extras | `reference.md`, `template.md`, `scripts/` (any name, linked from `SKILL.md`) | Same, conventionally under `references/`, `assets/`, `scripts/`, plus optional `agents/openai.yaml` for icon/display-name/tool-dependency metadata |

**Because `SKILL.md`'s required fields (`name`, `description`) are identical across both providers, a single `SKILL.md` body is normally portable as-is** — extra frontmatter keys one provider doesn't recognize (like Claude's `disable-model-invocation`) are simply ignored by the other, so it's safe to include even when also targeting ChatGPT. The only thing that can't be expressed in frontmatter alone is disabling implicit invocation *for ChatGPT/Codex specifically*, which needs the separate `agents/openai.yaml` file.

**When writing the skill:**
- **Claude only** → write to the `.claude/skills/` (or `~/.claude/skills/`) path.
- **ChatGPT/Codex only** → write to the `.agents/skills/` (or `~/.agents/skills/`) path; add `agents/openai.yaml` if User-Invoked or if display metadata is wanted.
- **Both (default)** → author one canonical `SKILL.md` (and any references/scripts), then place a copy at both the Claude path and the Codex path — these are separate directory trees, so this means writing the files twice, not linking. If User-Invoked, add the Codex-side `agents/openai.yaml` alongside the Codex copy; Claude's copy only needs the `disable-model-invocation: true` frontmatter field.

---

## 1. Trigger: User-Invoked vs. Model-Invoked

Every skill requires a `SKILL.md` file with YAML frontmatter containing a `description`. This description acts as a **context pointer** for the agent.

| Type | Configuration | Trade-offs |
|------|---------------|-------------|
| **Model-Invoked** | Claude: omits `disable-model-invocation: true`. ChatGPT/Codex: omits `agents/openai.yaml`, or sets `policy.allow_implicit_invocation: true` (the default). | Agent auto-discovers it. **Cost**: Increases "context load" and token usage on every request. Introduces unpredictability if the model ignores the pointer. |
| **User-Invoked** | Claude: uses `disable-model-invocation: true` in frontmatter. ChatGPT/Codex: uses `agents/openai.yaml` with `policy.allow_implicit_invocation: false`. | 100% predictable, zero idle context load. **Cost**: Increases "cognitive load" on the user who must remember to call it (`@skill-name` in ChatGPT, `/skills` or `$skill-name` in Codex). Best for complex, isolated tasks. |

### Writing Effective Descriptions (For Model-Invoked)
- **Write in third person**: The description is injected into the system prompt. (e.g., "Processes Excel files...", not "I can..." or "You can...")
- **Include WHAT and WHEN**: Specify capabilities and trigger scenarios (e.g., "Extract text from PDFs. Use when working with PDF files or document extraction.")
- **Be Specific**: Avoid vague names like `helper` or `utils`.
- **Front-load it**: Codex may truncate long descriptions when many skills are installed, so put the key use case and trigger words first.

---

## 2. Structure: Steps and References

Think of skills as composed of two main units: **Steps** (the step-by-step procedure) and **References** (supporting information).

### Directory Layout
```text
skill-name/
├── SKILL.md              # Required - Main steps and context pointers
├── reference.md          # Optional - Single source of truth for docs
├── template.md           # Optional - Output templates
├── scripts/               # Optional - Utility scripts
└── agents/
    └── openai.yaml        # ChatGPT/Codex only - invocation policy + UI metadata
```
This layout is identical regardless of target provider — only *where* the `skill-name/` folder gets placed (see Provider Compatibility) and whether `agents/openai.yaml` is included changes.

### Minimizing SKILL.md
1. **Progressive Disclosure**: Keep `SKILL.md` under 500 lines. Put essential instructions in `SKILL.md` and detailed material in separate files. Link to references **one level deep**.
2. **Branching**: If your skill has multiple use cases (branches), do not clutter `SKILL.md` with templates or references that only apply to one branch. Hide branching reference material behind **context pointers** (e.g., "If creating an ADR, read [adr-template.md](adr-template.md)").

---

## 3. Steering: Guiding Agent Behavior

If the agent doesn't follow instructions perfectly, use these techniques to steer it:

### Leading Words
Pack complex meaning into short, specific phrases (e.g., use "Vertical Slice" instead of explaining "don't code layer by layer"). 
- Use these terms consistently in the skill.
- The agent will repeat these leading words in its reasoning/thinking traces, which naturally shifts its behavior toward your desired outcome.

### Step Leg Work (Splitting Skills)
Agents sometimes lack "leg work" on intermediate steps. For example, in a "Planning Mode" skill, the agent might rush through asking clarifying questions to eagerly write the plan.
- **Solution**: Hide the future goal. Split the workflow into two separate user-invoked skills (e.g., a `grill-user` skill to gather requirements, followed by a `create-plan` skill). By restricting visibility to one step at a time, you force deep leg work.

### Degrees of Freedom
Match specificity to the task's fragility:
- **High Freedom** (text instructions): Context-dependent (e.g., Code review guidelines).
- **Medium Freedom** (templates): Preferred patterns (e.g., Report formatting).
- **Low Freedom** (utility scripts): Fragile operations (e.g., Database migrations). Use pre-made scripts rather than asking the agent to generate fragile code.

---

## 4. Pruning: Removing Superfluous Elements

Perform a deletion test on your skill. A massive skill is a symptom of poor pruning. Every token competes for space.

1. **Remove No-ops**: Remove instructions that don't actually change agent behavior. *(e.g., If you delete the sentence "write a high-quality commit message," will the agent still write a decent one by default? If yes, delete it.)*
2. **Don't Repeat Yourself (DRY)**: Ensure every piece of information and reference has a single source of truth.
3. **Clear Sediment**: In shared skills, irrelevant or stale material accumulates over time. Move branching logic to external references or kill stale docs dead.
4. **Assume the Agent is Smart**: Challenge every paragraph: "Does the agent really need this explanation? Does this justify its token cost?"

---

## 5. Common Skill Patterns

- **Template Pattern**: Provide markdown/code blocks for exact output formatting.
- **Examples Pattern**: Provide "Input -> Output" examples for formatting tasks (e.g., commit messages).
- **Checklist Pattern**: Break complex operations into clear steps with markdown checklists `[ ]` and ask the agent to track progress.
- **Feedback Loop Pattern**: For quality-critical tasks, mandate a validation script: "Make edits -> Run `validate.py` -> Fix errors -> Only proceed when validation passes."

---

## Anti-Patterns to Avoid
1. **Windows-Style Paths**: Always use `scripts/helper.py`, never `scripts\helper.py`.
2. **Too Many Options**: Don't say "You can use pypdf, or pdfplumber, or...". Provide a default with a specific escape hatch.
3. **Time-Sensitive Info**: Don't use statements like "Before August 2025". Use "Current method" and "Legacy method" sections.
4. **Inconsistent Terminology**: Pick one term (e.g., "API endpoint" instead of mixing "URL", "route", "path") and stick to it.

---

## Agent Workflow: Creating the Skill

When assisting a user in creating a skill, follow these phases:

### Phase 1: Design
Draft the skill name (lowercase, hyphens). Confirm the **target provider(s)** (default: Both, if unspecified). Determine if it is User-Invoked or Model-Invoked. Write the description. Identify strong **Leading Words**. Plan the **Steps** and identify what belongs in external **References**.

### Phase 2: Implementation
Create the directory and write `SKILL.md` using this exact structure — the body and frontmatter are the same regardless of target provider:

```markdown
---
name: your-skill-name
description: Third-person description of what it does and when to use it.
disable-model-invocation: true # Include if User-Invoked (Claude reads this; ChatGPT/Codex ignore it)
---

# Your Skill Name

## Steps
1. First step using strong Leading Words.
2. Second step.

## References
- For complex formatting, see [template.md](template.md)
```

Then place the folder per the target provider(s):
- **Claude** → `.claude/skills/your-skill-name/` or `~/.claude/skills/your-skill-name/`.
- **ChatGPT/Codex** → `.agents/skills/your-skill-name/` or `~/.agents/skills/your-skill-name/`. If User-Invoked, also add `agents/openai.yaml`:
  ```yaml
  policy:
    allow_implicit_invocation: false
  ```
- **Both** → write the identical `SKILL.md` (and any references/scripts) to *both* locations above; add the `agents/openai.yaml` only to the Codex copy.

### Phase 3: Final Pruning Checklist
Before finalizing the skill, verify:
- [ ] Description is specific and includes key terms (WHAT and WHEN).
- [ ] `SKILL.md` is heavily pruned (No-ops removed, no sediment).
- [ ] Branching reference material is moved to external files.
- [ ] Meaning is packed into consistent Leading Words.
- [ ] File references are only one level deep.
- [ ] Pre-made scripts are used for fragile operations instead of generated code.
- [ ] The skill folder is written to the correct path(s) for the requested provider(s) (`.claude/skills/` and/or `.agents/skills/`, or their `~/`-rooted personal equivalents).
- [ ] If User-Invoked and targeting ChatGPT/Codex, `agents/openai.yaml` with `allow_implicit_invocation: false` is present alongside that copy.
