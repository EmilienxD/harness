---
name: skill-prompt-engineering
description: Reference for writing high-quality Agent Skill content. Use when drafting or reviewing a SKILL.md body — descriptions, steps, references, and steering — regardless of which agent will run it.
---

# Writing High-Quality Skill Bodies

This is not about *configuring* a skill (frontmatter fields, install paths, invocation toggles). It's about the craft of the content itself: what makes a skill's instructions actually change agent behavior for the better. This applies the same way no matter which agent reads the file.

---

## 1. Writing the Description

The `description` field is the only thing the agent sees before deciding whether to load the rest of the skill. Treat it as a **context pointer**, not a summary.

- **Write in third person**: it gets injected into the system prompt alongside other skills. ("Processes Excel files...", not "I can..." or "You can...")
- **Include WHAT and WHEN**: name the capability *and* the trigger scenario. ("Extract text from PDFs. Use when working with PDF files or document extraction.")
- **Be specific**: avoid vague names like `helper` or `utils` — the agent can't match intent to a name it can't distinguish from ten others.
- **Front-load it**: put the key use case and trigger words in the first sentence. Long lists of installed skills sometimes get truncated or summarized down to a fragment — if the important part is at the end, it may never be seen.

---

## 2. Structure: Steps and References

Think of a skill as composed of two units: **Steps** (the procedure) and **References** (supporting material the agent only needs sometimes).

### Progressive Disclosure
Keep the main body lean. Put the essential instructions in the main file and move detailed material — templates, schemas, edge-case docs — into separate files. Link to them as **context pointers** rather than inlining them:

> "If creating an ADR, read [adr-template.md](adr-template.md)."

The agent only pays the token cost of a reference when the branch it applies to is actually taken.

### Depth Limit
Keep file references **one level deep**. A skill that links to a file that links to another file forces the agent to chain lookups before it can act — that's fragile and slow. Flatten it: either inline the content or bring the second-level file up to be a direct reference.

### Branching
If a skill covers multiple distinct use cases, don't let templates or reference material for only one branch sit in the main body — every reader pays for it even when it's irrelevant to their case. Hide branch-specific material behind a pointer keyed to the condition that makes it relevant.

### Length Discipline
Aim to keep the main body compact (a common rule of thumb is under ~500 lines). If it's growing past that, it's usually a sign that reference material hasn't been split out yet — see Pruning below.

---

## 3. Steering: Guiding Agent Behavior

If plain instructions aren't reliably changing behavior, these techniques shape it more directly.

### Leading Words
Pack complex meaning into a short, specific phrase instead of a paragraph of explanation. For example, use "Vertical Slice" rather than repeatedly explaining "don't code layer by layer."
- Use the term consistently everywhere it applies in the skill — don't vary the wording.
- The agent tends to repeat leading words back in its own reasoning, which is a sign the concept has actually taken hold rather than just being read past.

### Step Leg Work (Splitting Skills)
Agents sometimes rush through an intermediate step to get to the part that feels like "the real work" — e.g., skimming past clarifying questions to jump straight to writing a plan.
- **Solution**: hide the future goal. Split the workflow into two separate skills — one that only gathers requirements, and a second, separate one that only produces the output — so the agent can't see the end state while it's supposed to be doing the groundwork. Restricting visibility to one step at a time forces it to actually do that step properly instead of racing through it.

### Degrees of Freedom
Match how much latitude you give the agent to how fragile the task is:
- **High freedom (text instructions)** — for context-dependent judgment calls, e.g. code review guidelines, where rigid rules would misfire across cases.
- **Medium freedom (templates)** — for tasks with a preferred shape but some legitimate variation, e.g. report formatting.
- **Low freedom (pre-made scripts)** — for fragile, exact operations, e.g. database migrations. Don't ask the agent to generate this kind of code from a description; give it a script to run instead.

Giving more freedom than a task's fragility warrants invites drift; giving less than a task's complexity warrants produces brittle, over-specified instructions that break on the first edge case.

---

## 4. Pruning: Removing Superfluous Elements

A bloated skill is a symptom of unpruned content — every token in the body competes for the agent's attention with every other token, so waste has a real cost, not just a cosmetic one.

Run this deletion test on every instruction:

1. **Remove no-ops**: if you deleted this sentence, would the agent's behavior actually change? ("Write a high-quality commit message" — would it not do that anyway by default? If the default behavior is already fine, the instruction is dead weight.)
2. **DRY (Don't Repeat Yourself)**: every piece of information should have exactly one authoritative location. Duplicated guidance drifts out of sync over time and doubles the token cost for no benefit.
3. **Clear sediment**: shared or long-lived skills accumulate stale exceptions and half-relevant notes. Move branching logic out to references, or delete dead guidance outright rather than letting it pile up.
4. **Assume the agent is smart**: for every paragraph, ask whether it's teaching something the agent genuinely doesn't already know how to do well. Basic competence doesn't need to be re-explained; specialized, non-obvious, or house-specific knowledge does.

---

## 5. Common Skill Patterns

- **Template Pattern**: provide an exact markdown/code block for the output shape, rather than describing the shape in prose.
- **Examples Pattern**: give "Input → Output" pairs for formatting-sensitive tasks (e.g., commit message style) — examples often teach a format faster and more reliably than a description of the format.
- **Checklist Pattern**: break a complex multi-part operation into an explicit `[ ]` checklist and have the agent track progress against it, so nothing gets silently skipped.
- **Feedback Loop Pattern**: for quality-critical tasks, mandate a validation step in the instructions themselves: "Make edits → run `validate.py` → fix errors → only proceed once validation passes." This turns an unverifiable claim of correctness into a checked one.

---

## Anti-Patterns to Avoid

1. **Windows-style paths**: always write paths like `scripts/helper.py`, never `scripts\helper.py` — the backslash form breaks on non-Windows agents and environments.
2. **Too many options**: don't present a menu ("you can use pypdf, or pdfplumber, or..."). Pick a default and give one specific, named escape hatch for when the default doesn't fit. Open-ended option lists push the decision (and the risk of a bad one) onto the agent instead of resolving it in the skill.
3. **Time-sensitive phrasing**: avoid statements anchored to a moment in time ("Before August 2025, do X"). Use "Current method" and "Legacy method" sections instead, so the skill doesn't silently go stale as time passes.
4. **Inconsistent terminology**: pick one term for a concept (e.g., "API endpoint") and use it everywhere — don't alternate between "endpoint," "URL," and "route" for the same thing. Inconsistent naming makes it harder for the agent to recognize that two mentions refer to the same concept.