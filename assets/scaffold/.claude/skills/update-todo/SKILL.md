---
name: update-todo
description: Write or evolve the aboard project roadmap issue, one task at a time
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

Write the project roadmap if it does not exist yet, otherwise apply the user's argument to it. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

## If the roadmap section says this project has no roadmap yet

Write the first one, in three steps, with no confirmation gate.

1. **Delegate the survey.** Run an `Explore` agent over the repository, at very thorough breadth, and ask it to report in under 400 words: what the project is and does, its main components and what each is for, work that is visibly unfinished (TODO/FIXME comments, stubbed functions, empty test files, disabled code paths), and anything that looks broken, missing, or half-migrated — what is there, not a proposed plan. Delegate this rather than reading the repository yourself: a project-wide survey is the largest read you would ever perform, and it would land in the longest-lived context in the system and be lost at the first compaction.
2. **Ask what the code cannot tell you.** One `AskUserQuestion` round, three or four questions, then stop asking: what matters most next, what is deliberately unbuilt, what they consider done that the code makes look unfinished.
3. **Write it in one `todo_create` call.** Ten to twenty tasks, most important first, as a single batch.

## If the roadmap is already in your context

Apply granular `todo_create` and `todo_update` calls against the positions you already hold — read each task's position and current subject off the newest roadmap block. There is no fetch step and no full-body rewrite.

Then tell the user what moved, in one or two sentences. Not the whole document — they can read it on GitHub.
