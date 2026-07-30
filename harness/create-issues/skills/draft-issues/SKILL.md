---
name: draft-issues
description: Write the issue breakdown approved in /map-issues to markdown files in .issues-gateway/ for the user to review and edit before publishing.
disable-model-invocation: true
---

!`{ mkdir -p "./.issues-gateway/${CLAUDE_SESSION_ID}"; [ -e ./.issues-gateway/.gitignore ] || printf '*\n' > ./.issues-gateway/.gitignore; } >/dev/null 2>&1; true`

This skill is the step 2/3 of an issue publishing system from mapping to drafting to publishing. If first step (issue mapping) hasn't been called for this batch, stop immediatly and tell the user to do so.

It turns the breakdown approved in step 1 into one markdown file per issue. Do not run `gh` or publish anything — that only happens in the next step (publishing).

## Process

1. Write one file per issue

For each approved issue, create `.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md` where `{i}` is the issue number starting at 0 in the order you plan to publish them (blockers before what they block). Do not spend time checking whether the folder exists or what it already contains — the directory was just created in step 1 — just write the files using multiple Write tool calls in parallel.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels, defined from the previous step, and must contain nothing else:

<issue-template>
# {Issue title}

> {difficulty-label}, {mode-label}

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

- `{${CLAUDE_SESSION_ID}/{i}}` of the blocking issue, one per line

Or "None - can start immediately" if no blockers.

</issue-template>

`{difficulty-label}` is `difficulty:low`, `difficulty:medium`, or `difficulty:high`, matching the difficulty chosen in step 1. `{mode-label}` is `mode:afk` or `mode:hitl`, matching the mode chosen in step 1. Example second line: `> difficulty:medium, mode:hitl`.

In "Blocked by", reference other issues in this batch by their `${CLAUDE_SESSION_ID}/{i}` token, wrapped in curly braces — e.g. if the session id were `6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55`, a reference to issue 0 is `{6b1f0c2e-5a3d-4c19-9f7b-2e8a1d0c4f55/0}`. This works for references to issues in *this* batch only — a draft can't reference an issue from a different, unrelated batch. `/publish-issues` resolves these to real issue numbers once the referenced issue is published — don't try to resolve them yourself, and don't worry about getting the order perfect: unresolved references are retried automatically within a publish run, so an occasional misordering self-heals rather than getting silently stuck.

2. Hand off to the user

List the relative file paths you created (`.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md`) and tell the user they can review them. They can edit any file directly — title, labels, body, blockers — before publishing. Mention they can run `/publish-issues --dry-run` first to preview what would be created without touching the tracker, or `/publish-issues` to publish for real. Ask if they want changes.

Do NOT close or modify any parent issue.