---
name: update-todo
description: Write or evolve the aboard project roadmap issue, one task at a time
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

The roadmap is a flat checkbox list on one GitHub issue. It is the project's whole-lifetime record of what is left to do and what has been done — a point of reference, never a specification. Detail belongs in `ai:spec` issues.

Each task carries a 4-character id derived from its own text, rendered as `- [ ] [a3f9] Replace the locator`. **Copy an id from the roadmap block in your context; never invent one.** Editing a subject changes its id, so a call with a stale id fails and hands you the current list — retry with the id from that list.

## If the roadmap section says this project has no roadmap yet

Write the first one, in three steps, with no confirmation gate.

1. **Delegate the survey.** You are capped at three direct codebase queries, and a project-wide survey is the largest read you would ever perform — landing in the longest-lived context in the system and lost at the first compaction. Call `mcp__aboard__run_agent` with:

```
{
  "type": "Explore",
  "description": "Survey the project roadmap",
  "prompt": "Survey this repository so a project roadmap can be written for it. Report: what the project is and what it does; the main components and what each is for; work that is visibly unfinished (TODO/FIXME comments, stubbed functions, empty test files, disabled code paths); anything that looks broken, missing, or half-migrated. Very thorough breadth. Do not propose a plan — report what is there, in under 400 words."
}
```

2. **Ask what the code cannot tell you.** One `AskUserQuestion` round, three or four questions, then stop asking: what matters most next, what is deliberately unbuilt, what they consider done that the code makes look unfinished.

3. **Write it in one `mcp__aboard__todo_create` call.** Ten to twenty tasks, most important first, as one `subjects` array. One tool call, one issue revision:

```
{
  "subjects": [
    "Replace the ai:todo locator with a per-call label scan",
    "Pace roadmap reminders on transcript growth",
    "Document the two todo tools in the manager prompt"
  ]
}
```

## If the roadmap is already in your context

Apply `$ARGUMENTS` as granular `mcp__aboard__todo_create` and `mcp__aboard__todo_update` operations against the ids you already hold. There is no fetch step and no full-body rewrite.

Examples:

```
todo_create({ "subjects": ["Cache the resolved default branch"], "after": "top" })
todo_update({ "task": "a3f9", "status": "completed" })
todo_update({ "task": "b2c1", "subject": "Pace reminders on measured transcript growth" })
todo_update({ "task": "c4d2", "after": "a3f9" })
```

- `todo_create` appends by default; `after: "top"` puts newly discovered urgent work where it belongs, and `after: "<id>"` places it after a specific task.
- `todo_update` with `after` **is** the reprioritize operation. List order is priority; the first unchecked item is next.
- `status: "completed"` leaves the task in place as `- [x]`. Completed items are never sunk, capped, or pruned.
- `status: "deleted"` removes the line. **Only ever on the user's explicit request** — never because a task looks obsolete to you.

Send independent tool calls in one message so they run concurrently, unless one depends on an id the previous call returns.

Then tell the user what moved, in one or two sentences. Not the whole document — they can read it on GitHub.
