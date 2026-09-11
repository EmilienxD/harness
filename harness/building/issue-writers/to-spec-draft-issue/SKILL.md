---
name: to-spec-draft-issue
description: Turn the current conversation into a spec, as a draft issue — no interview, just synthesis of what you've already discussed.
disable-model-invocation: true
---

Use what the user provided alongside the invocation as this skill's input. A provider-specific hook has already supplied an **issues session id**, **draft directory**, and **next free issue index** as context. Use those exact values for `<issues-session-id>` and `<next-free-issue-index>` below. Do not recompute them.

Turn the current conversation context and codebase understanding into a single GitHub **spec issue**. Do NOT interview the user; just synthesize what you already know.

This skill is part of an issue publishing system that uses a gateway for publishing issues. Your job stops at spec drafting, as a markdown file. The gateway handles publishing automatically — you are not allowed to call `gh issue create`.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments, plus any relevant reference in that body. Use the project's domain glossary vocabulary throughout the spec if available.

### 2. Explore the codebase (optional)

If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code.
Look for prefactoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 3. Pin down the spec

Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better — the ideal number is one. Check with the user that these seams match their expectations.

If the feature is too unclear to write a useful spec, say what is missing instead of inventing requirements.

### 2. Write 1 file

Create `.issues-gateway/<issues-session-id>/issue-{i}.md` where {i} is:
<next-free-issue-index>

Do not spend time checking whether the folder exists or what it already contains — just write the file.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels and must contain nothing else:

<spec-template>
# {Spec title}

> spec

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made, such as:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>

`{labels}` is a comma-separated list containing the labels. All labels written will be automatically created by the system in GitHub if they don't exist.

Keep `spec` as a mandatory label.

If the user asks for extra labels, verify them before writing the file: run `gh label list` and confirm each requested label exists in this repo, mapping it to the repo's own spelling. Don't invent labels — if a requested one doesn't exist, flag it to the user before proceeding, or propose a similar existing label (e.g. when the user's label has a typo).

Examples:
```
> spec
# or
> spec, security
# or
> spec, good first issue
```

### 3. Hand off to the user

Tell the user the relative file path you created and that they can review it. They can edit the file directly — title, labels, body, parent — before publishing. Ask if they want you to make changes. Mention that they can invoke `publish-issues` with `--dry` first to preview what would be created without touching the tracker, or without `--dry` to publish for real.

