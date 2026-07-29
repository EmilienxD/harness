---
name: map-issues
description: Break a plan, spec, or PRD into a proposed set of issues, entirely in chat. Use when the user wants to plan out issues before anything is written to disk or published.
disable-model-invocation: true
---

# Map Issues

> This skill is the step 1/3 of an issue publishing system from mapping to drafting to publishing.

Break a plan into a proposed set of issues, entirely in chat. Do not create any files or issues in this step — that happens in `/draft-issues` and `/publish-issues`.

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
- Prefer fewer, well-scoped issues over many tiny ones. Every issue is a full agent run, so the goal is minimal total LLM cost for correct work, not maximum parallelism.

Issues are worked one at a time, never in parallel — don't optimize the breakdown for concurrency. Optimize for quality over speed: each issue should be scoped so the agent assigned to it gets it right in one pass.

For each issue, decide:

- **Title**: short descriptive name
- **Summary**: what this issue covers, in a sentence or two
- **Blocked by**: which other issues, if any, must complete first
- **Difficulty**: `low`, `medium`, or `high` — your honest estimate of how hard this issue is to execute correctly. This is used to choose which model runs it later. Routine, well-understood work is `low`; multi-step work with real design decisions is `medium`; anything needing careful judgment, wide context, or unusual reasoning is `high`.
- **Mode**: `afk` or `hitl`. Use `hitl` when the work is sensitive, touches frontend or UI design, or is complex enough that a human should review it before it lands. Use `afk` when the agent can be trusted to implement it in one shot with no review.

### 4. Quiz the user

Present the proposed breakdown as a numbered list, showing title, summary, blocked-by, difficulty, and mode for each issue.

Ask the user:

- Does the granularity feel right? (too coarse / too fine — remember, one agent per issue)
- Are the dependency relationships correct?
- Do the difficulty and mode assignments look right?
- Should any issues be merged or split further?

Iterate until the user approves the breakdown. Once approved, tell them they can run `/draft-issues` to write it to disk for review.
