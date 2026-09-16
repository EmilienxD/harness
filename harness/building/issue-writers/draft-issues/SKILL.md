---
name: draft-issues
description: Break a plan or specification into connected tracer-bullet issue drafts. Use when the work needs multiple reviewable tickets before publication.
argument-hint: "[plan, spec, issue, or request]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Use what the user provided alongside the invocation as this skill's input. A provider-specific hook has already supplied an **issues session id**, **draft directory**, and **next free issue index** as context. Use those exact values for `<issues-session-id>` and `<next-free-issue-index>` below. Do not recompute them.

Break a plan, spec, or conversation into a set of GitHub **issues**: tracer-bullet vertical slices, each declaring the issues that **block** it.

This skill is part of an issue publishing system that uses a gateway for publishing issues. Your job stops at issue drafting, as markdown files. The gateway handles publishing automatically — you are not allowed to call `gh issue create`.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a description as an argument, use it. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments, plus any relevant reference in that body.

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
- **Parent**: the issue this one is a piece of, if there is one — typically the spec these issues were broken out of, or the existing issue passed as an argument. Publishing turns this into a real GitHub sub-issue link, so it is worth getting right; leave it out when the issue stands on its own.
- **Blocked by**: which other issues, if any, must complete first
- **Difficulty** (default, but optional): your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Select one of:
  - `routine`: For low reasoning level work such as renaming a variable, cleaning up files/folders, adding missing type hint. 1% usage rate; use this rarely.
  - `basic`: For easy and small refactoring such as splitting a function into multiple functions, updating a model or signature, adding missing tests, writing or updating documentation. 5% usage rate.
  - `advanced`: For multi-step work with expected outcomes, low chance of encountering bugs, easy UI design. 34% usage rate.
  - `expert`: For multi-step complex work, anything needing careful judgment, complex UI design, wide context and bug prone. 60% usage rate.
- **Mode** (default, but optional): `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.
- **Browser**: add `chrome` when the task needs a real browser to test a design change end to end. Omit it when browser testing is unnecessary or a non-browser test is sufficient.
- **Extra labels** (only if the user asks): any other labels the user explicitly requests.

Both the difficulty and mode labels are defaults, not requirements: if the user explicitly says not to use one or both of them, leave them off the breakdown entirely rather than forcing a value.

If the user asks for extra labels, verify them before the breakdown is finalized: run `gh label list` and confirm each requested label exists in this repo, mapping it to the repo's own spelling. Don't invent labels — if a requested one doesn't exist, flag it to the user before proceeding, or propose a similar existing label (e.g. when the user's label has a typo).

### 4. Review the mapping with the user

Present the proposed breakdown as a numbered list, showing title, summary, parent, blocked-by, and whichever labels were decided (difficulty, mode, extras) for each issue.

Ask the user:

- Does the granularity feel right? (too coarse / too fine — remember, one agent per issue)
- Is the parent right, if these issues belong under one?
- Are the dependency relationships correct?
- Do the label assignments look right — difficulty and mode where they're used, `chrome` where real-browser end-to-end design testing is needed, and any extras?
- Should any issues be merged or split further?

Iterate until the user approves the breakdown. Stop after presenting or revising the mapping and wait for their response. Once the user approves it, continue directly with the drafting steps below in that same conversation; do not ask them to invoke this skill again.

### 5. Write one file per issue

Write one draft file per finding at the file paths instructed by the hook. If no hook gave you that info, stop immediatly and alert the user about the bug instead of finding a workaround.

Index them in the order you plan to publish them (blockers before what they block).

Do not spend time checking whether the folder exists or what it already contains — just trust the hook and write all files in parallel.

Use the template:
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

`{labels}` is a comma-separated list containing the difficulty and mode tokens decided during mapping, plus `chrome` where required. All workflow labels written will be automatically created by the system in GitHub if they don't exist.

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

In "Parent" and "Blocked by", reference other issues drafted in this turn by their plain-text `<issues-session-id>/{i}` token — never wrap it in backticks or braces; the system will rewrite it to a bare `#<number>` resolving to real issue numbers once the referenced issue is published. This works for references to issues from THIS TURN ONLY — a draft can't reference an issue from a different, unrelated turn. To reference an issue not drafted in this turn, use the real existing GitHub issue number. Once this turn's issues are published, you will be notified of the result and the actual GitHub numbers of the published issues, so you don't need any additional `gh` calls to get the issue numbers for the next turns in this session.

### 6. Hand off to the user

List the relative file paths you created and tell the user they can review them. They can edit any file directly — title, labels, body, blockers — before publishing. Ask if they want you to make changes. Mention that they can invoke `publish-issues` with `--dry` first to preview what would be created without touching the tracker, or without `--dry` to publish for real.
