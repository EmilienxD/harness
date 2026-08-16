---
name: update-todo
description: Write or evolve the aboard project roadmap issue, one task at a time
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

The roadmap is a flat checkbox list on one GitHub issue. It is the project's whole-lifetime record of what is left to do and what has been done — a point of reference, never a specification. Detail belongs in `ai:spec` issues.

Each task is addressed by its **position**, rendered as `4. [ ] Replace the locator`. Positions are absolute over the whole roadmap, so a pending-only list shows real but non-consecutive numbers — `4, 9, 12` means exactly those.

`todo_update` takes two addressing fields and needs both: `task` is the position, and `expect` is that task's current subject (or at least its first 40 characters), copied not paraphrased. The position says which line to change; `expect` proves you are looking at the task you mean, so a roadmap the user edited on their phone cannot silently take your write. **Read both off the newest roadmap block in your context.** A position that does not exist, or an `expect` that does not match, writes nothing and hands you the current list — retry against that.

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

Apply `$ARGUMENTS` as granular `mcp__aboard__todo_create` and `mcp__aboard__todo_update` operations against the positions you already hold. There is no fetch step and no full-body rewrite.

Examples:

```
todo_create({ "subjects": ["Cache the resolved default branch"], "after": "top" })
todo_update({ "task": 4, "expect": "Replace the locator", "status": "completed" })
todo_update({ "task": 9, "expect": "Pace the reminders", "subject": "Pace reminders on measured transcript growth" })
todo_update({ "task": 12, "expect": "Document the verbs", "after": 4 })
```

- `todo_create` appends by default; `after: "top"` puts newly discovered urgent work where it belongs, and `after: <position>` places it after a specific task.
- `todo_update` with `after` **is** the reprioritize operation. List order is priority; the first unchecked item is next.
- An insert, a move, or a deletion **renumbers every task after it**. Those calls return `tasks`, the pending list as it now stands: use it and drop the positions you were holding. An append, a status change, and a retitle renumber nothing and return no list.
- `status: "completed"` leaves the task in place as `- [x]`. Completed items are never sunk, capped, or pruned.
- `status: "deleted"` removes the line. **Only ever on the user's explicit request** — never because a task looks obsolete to you.

Send roadmap writes **one at a time**, not batched into one message. Every call rewrites the same issue body, so two in flight together lose one of the two edits, and a call that renumbers invalidates the positions its neighbour was written against. Batch within a call instead: one `todo_create` takes many subjects.

Then tell the user what moved, in one or two sentences. Not the whole document — they can read it on GitHub.
