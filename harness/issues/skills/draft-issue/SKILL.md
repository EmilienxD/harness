---
name: draft-issue
description: Draft a single GitHub issue to a markdown file in .issues-gateway/ for the user to review and edit before publishing. Use when the user wants to create one issue, with no multi-issue breakdown needed.
disable-model-invocation: true
---

This skill handles ONLY drafting in an issue publishing system: drafting, then publishing. It turns what the user wants — from the conversation, or from the argument passed to this skill — into a markdown file.

Publishing happens separately in the later publishing step. Do not run `gh` or publish anything.

## Process

1. Pin down the issue

Work from whatever is already in the conversation. If the user passes a description as an argument, use it. If the argument is an issue number or URL, fetch it with `gh issue view` and treat that issue as the parent. If the title, scope, or acceptance criteria are still unclear, ask one short round of questions before writing anything.

Optionally explore the codebase so "What to build" describes the real end-to-end behavior, not a guess.

Scope constraint: exactly **one agent, working alone, in one pass**. If what the user describes is bigger than that, say so and ask them to narrow the scope instead of drafting an oversized issue.

Decide the labels:

- **Difficulty** (default, but optional): `low`, `medium`, or `high` — your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Routine, well-understood work is `low`; multi-step work with real design decisions is `medium`; anything needing careful judgment, wide context, or unusual reasoning is `high`.
- **Mode** (default, but optional): `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.

Both labels are defaults, not requirements: if the user explicitly says not to use the difficulty and/or mode label, leave that label off the declaration line entirely — don't fall back to a guessed value.

If the user explicitly asks for other labels (e.g. `ci`, `good-first-issue`), verify each one before writing it: run `gh label list` and confirm the label name exists in this repo, mapping it through the repo's own spelling. Do not invent labels that aren't there — if a requested label doesn't exist, flag it to the user and ask, rather than writing a label `gh` will reject at publish time.

2. Write 1 file

Create `.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md` where {i} is:
!`d="./.issues-gateway/${CLAUDE_SESSION_ID}"; mkdir -p "$d"; [ -e ./.issues-gateway/.gitignore ] || printf '*\n' > ./.issues-gateway/.gitignore; max=-1; for f in "$d"/issue-*.md; do [ -f "$f" ] || continue; i="${f##*/issue-}"; i="${i%%[^0-9]*}"; [ -n "$i" ] && [ "$i" -gt "$max" ] && max="$i"; done; echo $((max + 1))`

Do not spend time checking whether the folder exists or what it already contains — just write the file.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels and must contain nothing else:

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

A reference to each blocking issue, or "None — can start immediately".

</issue-template>

`{labels}` is a comma-separated list of `difficulty:low|medium|high`, `mode:afk|hitl`, and any extra labels requested and verified above — the difficulty and mode tokens are each included only when decided, so any of `> difficulty:medium, mode:hitl`, `> difficulty:low`, `> mode:afk`, or `> ci, difficulty:low` is a valid line. Every issue must carry at least one label.

3. Hand off to the user

Tell the user the relative file path you created and that they can review it. They can edit the file directly — title, labels, body, blockers — before publishing. Mention they can run `/publish-issues --dry` first to preview what would be created without touching the tracker, or `/publish-issues` to publish for real. Ask if they want changes.

Do NOT close or modify any parent issue.
