---
name: to-spec-draft-issue
description: Turn the current conversation into a spec, as a draft issue — no interview, just synthesis of what you've already discussed.
disable-model-invocation: true
---

This skill handles ONLY spec drafting in an issue publishing system: drafting, then publishing. It takes the current conversation context and codebase understanding and produces a spec as a markdown file. Do NOT interview the user — just synthesize what you already know.

Publishing happens separately in the later publishing step. Do not run `gh` or publish anything.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary, if available, throughout the spec.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

3. Write the spec using the template below. Create `.issues-gateway/${CLAUDE_SESSION_ID}/issue-{i}.md` where {i} is:
!`d="./.issues-gateway/${CLAUDE_SESSION_ID}"; mkdir -p "$d"; [ -e ./.issues-gateway/.gitignore ] || printf '*\n' > ./.issues-gateway/.gitignore; max=-1; for f in "$d"/issue-*.md; do [ -f "$f" ] || continue; i="${f##*/issue-}"; i="${i%%[^0-9]*}"; [ -n "$i" ] && [ "$i" -gt "$max" ] && max="$i"; done; echo $((max + 1))`

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

A list of implementation decisions that were made. This can include:

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

Make sure to respect the `> spec` second non-empty line. The publishing hook maps it to the `[AI]-spec` label and automatically creates that label in the repo if missing. Do not write the `[AI]-` prefix in the draft.

If this spec belongs under an existing tracker issue — an epic, or an issue the user named — add a `## Parent` section directly below the `> spec` line whose only content is one bare reference on its own line: `#42` or the issue URL, as plain text with no backticks and no prose. `/publish-issues` turns that into a real GitHub sub-issue link and strips the section from the published body. Omit the section entirely otherwise; most specs are top-level.

Issues broken out of this spec later (via `/draft-issues`) become its sub-issues, so the spec does not need to list them.

5. Hand off to the user

Tell the user the relative file path you created and that they can review it. They can edit the file directly — title, labels, body — before publishing. Mention they can run `/publish-issues --dry` first to preview what would be created without touching the tracker, or `/publish-issues` to publish for real. Ask if they want changes.

Do NOT close or modify any parent issue.
