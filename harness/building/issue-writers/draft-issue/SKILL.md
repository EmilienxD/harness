---
name: draft-issue
description: Developer-invoked only. Agents must not invoke this skill on their own. Turn a request or plan into one tracer-bullet issue draft. Use when the work belongs in a single reviewable ticket.
argument-hint: "[request, plan, spec, or reference]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Turn a plan, spec or conversation into a single GitHub issue.

Write a Markdown draft through the issues gateway provided by the system. If you didn't get access to it, stop and alert the developer. Hand the draft back for review or publish immediatly if explicitly asked using the gateway script; you are not allowed to call `gh issue create`.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the developer passes a description as an argument, use it. If the developer passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body, plus any relevant reference in that body.

(optional) If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code.
Look for refactoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 3. Pin down the issue

Scope constraint: exactly **one agent, working alone, in one pass**. If what the developer describes is bigger than that, say so and ask them to narrow the scope instead of drafting an oversized issue.

Decide the labels:

- **Difficulty** (default, but optional): your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Select one of:
  - `routine`: For low reasoning level work such as renaming a variable, cleaning up files/folders, adding missing type hint. 1% usage rate; use this rarely.
  - `basic`: For easy and small refactoring such as splitting a function into multiple functions, updating a model or signature, adding missing tests, writing or updating documentation. 5% usage rate.
  - `advanced`: For multi-step work with expected outcomes, low chance of encountering bugs, easy UI design. 34% usage rate.
  - `expert`: For multi-step complex work, anything needing careful judgment, complex UI design, wide context and bug prone. 60% usage rate.
- **Mode** (default, but optional): `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.
- **Browser**: add `chrome` when the task needs a real browser to test a design change end to end. Omit it when browser testing is unnecessary or a non-browser test is sufficient.
- **Extra labels** (only if the developer asks): any other labels the developer explicitly requests.

Both the difficulty and mode labels are defaults, not requirements: if the developer explicitly says not to use one or both of them, leave them off the declaration line entirely rather than forcing a value.

Include any extra labels the developer requests in the draft. Publication automatically creates missing labels and preserves existing labels.

### 2. Write one file

Write the draft file at the file path instructed by the hook. If no hook gave you that info, stop immediately and alert the developer about the bug instead of finding a workaround.

Do not spend time checking whether the folder exists or what it already contains — just trust the hook and write the file.

Use the template below:
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

### 4. Publish or hand off

After publication, you will be notified whether each draft was modified since drafting; rely on this status to check for edits.

If the developer explicitly requested publication, run the `<skill-directory>/scripts/publish_issues.py` gateway script. Add `--dry` to preview. The script publishes all remaining drafts in the current session. Report the returned results in one sentence.

Otherwise, tell the developer the relative file path you created and that they can review it. They can edit the file directly — title, labels, body, parent — before publishing. Ask if they want you to make changes. Mention that they can invoke `publish-issues` with `--dry` first to preview or without to publish for real.
