---
name: draft-issues
description: Break a plan, spec, or PRD into an approved issue breakdown, then write it to markdown files in .issues-gateway/ for the user to review and edit before publishing.
disable-model-invocation: true
---

This skill handles ONLY mapping and drafting in an issue publishing system: map the issues, agree on the breakdown with the user, then draft the approved issues for review. It turns what the user wants — from the conversation, or from the argument passed to this skill — into a markdown file.

Publishing happens separately in the later publishing step. Do not create issue draft files or publish anything while mapping. Once the user approves the breakdown, proceed directly to drafting it without asking them to invoke `/draft-issues` again. Do not run `gh` while drafting or publish anything — that only happens in the next step.

## Process

### 1. Gather context

Work from whatever is already in the conversation. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it using `gh view` and read its full body and comments.

### 2. Explore the codebase (optional)

If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code.
Look for prefactoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 3. Propose the breakdown

Break the plan into issues. Each issue is scoped for exactly **one agent, working alone, in one pass** — not a team, not a pipeline, not a follow-up issue to patch what the first one missed. That constraint drives the granularity:

- Coarse enough that one agent has a real end-to-end scope to work with, not a single-file edit.
- Narrow enough that one agent can complete it correctly without needing another issue's output mid-flight.
- Each issue touches one coherent scope of the project — a feature, a layer boundary, a vertical slice — rather than scattering small edits across unrelated areas.
- Prefer fewer, well-scoped issues over many tiny ones. Every issue is a full agent run, so the goal is minimal total LLM cost for correct work, not maximum parallelism. LLMs are very powerful nowadays.

Issues are worked one at a time, never in parallel — don't optimize the breakdown for concurrency. Optimize for quality over speed: each issue should be scoped so the agent assigned to it gets it right in one pass.

For each issue, decide:
- **Title**: short descriptive name
- **Summary**: what this issue covers, in a sentence or two
- **Blocked by**: which other issues, if any, must complete first
- **Difficulty** (default, but optional): your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Select one of:
  - `routine`: For low reasoning level work such as renaming a variable, cleaning up files/folders, adding missing type hint. 1% usage rate; use this rarely.
  - `basic`: For easy and small refactoring such as splitting a function into multiple functions, updating a model or signature, adding missing tests, writing or updating documentation. 5% usage rate.
  - `advanced`: For multi-step work with expected outcomes, low chance of encountering bugs, easy UI design. 34% usage rate.
  - `expert`: For multi-step complex work, anything needing careful judgment, complex UI design, wide context and bug prone. 60% usage rate.
- **Mode** (default, but optional): `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.
- **Extra labels** (only if the user asks): any other labels the user explicitly requests.

Both the difficulty and mode labels are defaults, not requirements: if the user explicitly says not to use one or both of them, leave them off the breakdown entirely rather than forcing a value.

If the user asks for extra labels, verify them before the breakdown is finalized: run `gh label list` and confirm each requested label exists in this repo, mapping it to the repo's own spelling. Don't invent labels — if a requested one doesn't exist, flag it to the user before proceeding.

### 4. Review the mapping with the user

Present the proposed breakdown as a numbered list, showing title, summary, blocked-by, and whichever labels were decided (difficulty, mode, extras) for each issue.

Ask the user:

- Does the granularity feel right? (too coarse / too fine — remember, one agent per issue)
- Are the dependency relationships correct?
- Do the label assignments look right — difficulty and mode where they're used, any extras?
- Should any issues be merged or split further?

Iterate until the user approves the breakdown. Stop after presenting or revising the mapping and wait for their response. Once the user approves it, continue directly with the drafting steps below in that same conversation; do not ask them to invoke this skill again.

### 5. Write one file per issue

For each approved issue, create `.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md` where `{i}` is the issue number starting at:
!`d="./.issues-gateway/${CLAUDE_SESSION_ID}"; mkdir -p "$d"; [ -e ./.issues-gateway/.gitignore ] || printf '*\n' > ./.issues-gateway/.gitignore; max=-1; for f in "$d"/issue-*.md; do [ -f "$f" ] || continue; i="${f##*/issue-}"; i="${i%%[^0-9]*}"; [ -n "$i" ] && [ "$i" -gt "$max" ] && max="$i"; done; echo $((max + 1))`
in the order you plan to publish them (blockers before what they block). Do not spend time checking whether the folder exists or what it already contains — just write the files using multiple Write tool calls in parallel.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels, defined during mapping, and must contain nothing else:

<issue-template>
# {Issue title}

> {labels}

## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

${CLAUDE_SESSION_ID}/{i} of each blocking issue, one per line, as plain text (no backticks, no braces), or "None - can start immediately" if no blockers.

</issue-template>

`{labels}` is a comma-separated list containing the difficulty and mode tokens decided during mapping — `difficulty:routine|basic|advanced|expert` and `mode:afk|hitl` — plus any extra labels approved during mapping. Each token is written only if it was decided: if the user asked for the difficulty and/or mode labels to be skipped, they're simply absent, so `> difficulty:advanced, mode:hitl`, `> mode:afk`, `> difficulty:basic`, and `> ci, mode:hitl` are all valid lines. Every issue must carry at least one label. Any extra label approved during mapping was verified to exist in this repo (`gh label list`) before being written here — never invent a label name.

In "Blocked by", reference other issues in this batch by their plain-text `${CLAUDE_SESSION_ID}/{i}` token — e.g. if the session id were `6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55` and the starting index were `2`, a reference to the first issue in this batch is `6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/2`. Never wrap it in backticks or braces: the reference must stay plain text, because `/publish-issues` rewrites it to a bare `#<number>` and GitHub only autolinks issue numbers that aren't inside inline code. This works for references to issues in *this* batch only — a draft can't reference an issue from a different, unrelated batch. `/publish-issues` resolves these to real issue numbers once the referenced issue is published — don't try to resolve them yourself, and don't worry about getting the order perfect: unresolved references are retried automatically within a publish run, so an occasional misordering self-heals rather than getting silently stuck.

### 6. Hand off to the user

List the relative file paths you created and tell the user they can review them. They can edit any file directly — title, labels, body, blockers — before publishing. Mention they can run `/publish-issues --dry` first to preview what would be created without touching the tracker, or `/publish-issues` to publish for real. Ask if they want changes.

Do NOT close or modify any parent issue.
