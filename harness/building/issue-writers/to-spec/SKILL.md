---
name: to-spec
description: Developer-invoked only. Agents must not invoke this skill on their own. Synthesize the current conversation into a specification. Use when the developer wants a spec without another interview or an issue draft.
argument-hint: "[reference or focus]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Turn the current conversation context and codebase understanding into a single GitHub spec issue. Do NOT interview the developer; just synthesize what you already know.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the developer passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body, plus any relevant reference in that body. Use the project's domain glossary vocabulary throughout the spec if available.

(Optional) If you haven't already explored the codebase or read the related contract documents, do so to understand the current state of the code. Look for pre-factoring opportunities that make the implementation easier. "Make the change easy, then make the easy change."

### 2. Pin down the spec

Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better — the ideal number is one. Check with the developer that these seams match their expectations.

If the feature is too unclear to write a useful spec, say what is missing instead of inventing requirements.

### 3. Write a spec

Write the spec using the template below. **Default: write the spec directly in the end turn message.** Do not write it to a file, and do not create a GitHub issue, unless the developer explicitly asked for one of those in this invocation.

<spec-template>

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

### 4. Hand off to the developer

Tell the developer the spec is ready and state that you are ready to move to the next steps.