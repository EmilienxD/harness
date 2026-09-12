---
name: draft-issue
description: Turn a request, a plan, or the current conversation into one tracer-bullet ticket declaring its blocking edges, written to a markdown file for the user to review and edit before publishing. Use when a single issue is wanted, with no multi-issue breakdown.
disable-model-invocation: true
---

Use what the user provided alongside the invocation as this skill's input. A provider-specific hook has already supplied an **issues session id**, **draft directory**, and **next free issue index** as context. Use those exact values for `<issues-session-id>` and `<next-free-issue-index>` below. Do not recompute them.

Turn a plan, spec or conversation into a single GitHub **issue**.

This skill is part of an issue publishing system that uses a gateway for publishing issues. Your job stops at issue drafting, as a markdown file. The gateway handles publishing automatically — you are not allowed to call `gh issue create`.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a description as an argument, use it. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments, plus any relevant reference in that body.

### 2. Explore the codebase (optional)

If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code.
Look for prefactoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 3. Pin down the issue

Scope constraint: exactly **one agent, working alone, in one pass**. If what the user describes is bigger than that, say so and ask them to narrow the scope instead of drafting an oversized issue.

Decide the labels:

- **Difficulty** (default, but optional): your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Select one of:
  - `routine`: For low reasoning level work such as renaming a variable, cleaning up files/folders, adding missing type hint. 1% usage rate; use this rarely.
  - `basic`: For easy and small refactoring such as splitting a function into multiple functions, updating a model or signature, adding missing tests, writing or updating documentation. 5% usage rate.
  - `advanced`: For multi-step work with expected outcomes, low chance of encountering bugs, easy UI design. 34% usage rate.
  - `expert`: For multi-step complex work, anything needing careful judgment, complex UI design, wide context and bug prone. 60% usage rate.
- **Mode** (default, but optional): `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.
- **Browser**: add `chrome` when the task needs a real browser to test a design change end to end. Omit it when browser testing is unnecessary or a non-browser test is sufficient.
- **Extra labels** (only if the user asks): any other labels the user explicitly requests.

Both the difficulty and mode labels are defaults, not requirements: if the user explicitly says not to use one or both of them, leave them off the declaration line entirely rather than forcing a value.

If the user asks for extra labels, verify them before writing the file: run `gh label list` and confirm each requested label exists in this repo, mapping it to the repo's own spelling. Don't invent labels — if a requested one doesn't exist, flag it to the user before proceeding, or propose a similar existing label (e.g. when the user's label has a typo).

### 2. Write one file

Create `.issues-gateway/<issues-session-id>/issue-{i}.md` where {i} is:
<next-free-issue-index>

Do not spend time checking whether the folder exists or what it already contains — just write the file.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels and must contain nothing else:

<issue-template>
# {Issue title}

> {labels}

## Parent

One bare reference and nothing else — see below. Omit this whole section when the issue has no parent.

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

A reference to each blocking issue (see instructions below), or "None — can start immediately".

</issue-template>

`{labels}` is a comma-separated list containing the difficulty and mode tokens decided above, plus `chrome` when required. All workflow labels written will be automatically created by the system in GitHub if they don't exist.

Examples:
```
> difficulty:advanced, mode:hitl
# or
> difficulty:advanced, mode:hitl, chrome
# or
> difficulty:basic
# or
> mode:afk
```

### 3. Hand off to the user

Tell the user the relative file path you created and that they can review it. They can edit the file directly — title, labels, body, blockers — before publishing. Ask if they want you to make changes. Mention that they can invoke `publish-issues` with `--dry` first to preview what would be created without touching the tracker, or without `--dry` to publish for real.
