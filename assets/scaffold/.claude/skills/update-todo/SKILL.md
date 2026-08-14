---
name: update-todo
description: Write or evolve the aboard project roadmap issue, one task at a time
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

The roadmap is a flat checkbox list on one GitHub issue. It is the project's whole-lifetime record of what is left to do and what has been done — a point of reference, never a specification. Detail belongs in `ai:spec` issues.

Each task carries a 4-character id derived from its own text, rendered as `- [ ] [a3f9] Replace the locator`. **Copy an id from the roadmap block in your context; never invent one.** Editing a subject changes its id, so a call with a stale id fails and hands you the current list — retry with the id from that list.

## Quoting

Subjects routinely contain backticks and apostrophes, and backticks inside double quotes are command substitution. **Single-quote every `--subject`**, and write `'\''` for each apostrophe, so `don't` becomes `don'\''t`.

## If the roadmap section says this project has no roadmap yet

Write the first one, in three steps, with no confirmation gate.

1. **Delegate the survey.** You are capped at three direct codebase queries, and a project-wide survey is the largest read you would ever perform — landing in the longest-lived context in the system and lost at the first compaction. Launch an `Explore` agent instead:

```
printf '%s' 'Survey this repository so a project roadmap can be written for it. Report: what the project is and what it does; the main components and what each is for; work that is visibly unfinished (TODO/FIXME comments, stubbed functions, empty test files, disabled code paths); anything that looks broken, missing, or half-migrated. Very thorough breadth. Do not propose a plan — report what is there, in under 400 words.' > "${TMPDIR:-/tmp}/aboard-prompt-survey.md" && uv run --no-project "$ABOARD_CLI" agent --type Explore --description "Survey the project for a roadmap" --prompt - < "${TMPDIR:-/tmp}/aboard-prompt-survey.md"
```

2. **Ask what the code cannot tell you.** One `AskUserQuestion` round, three or four questions, then stop asking: what matters most next, what is deliberately unbuilt, what they consider done that the code makes look unfinished.

3. **Write it in one call.** Ten to twenty tasks, most important first, `--subject` repeated. One spawn, one issue revision:

```
uv run --no-project "$ABOARD_CLI" todo create \
  --subject 'Replace the ai:todo locator with a per-call label scan' \
  --subject 'Pace roadmap reminders on transcript growth' \
  --subject 'Document the two todo verbs in the manager prompt'
```

## If the roadmap is already in your context

Apply `$ARGUMENTS` as granular operations against the ids you already hold. There is no fetch step and no full-body rewrite.

```
uv run --no-project "$ABOARD_CLI" todo create --subject 'Cache the resolved default branch' --after top
uv run --no-project "$ABOARD_CLI" todo update --task a3f9 --status completed
uv run --no-project "$ABOARD_CLI" todo update --task b2c1 --subject 'Pace reminders on measured transcript growth'
uv run --no-project "$ABOARD_CLI" todo update --task c4d2 --after a3f9
```

- `create` appends by default; `--after top` puts newly discovered urgent work where it belongs, and `--after <id>` places it after a specific task.
- `update --after` **is** the reprioritize operation. List order is priority; the first unchecked item is next.
- `--status completed` leaves the task in place as `- [x]`. Completed items are never sunk, capped, or pruned.
- `--status deleted` removes the line. **Only ever on the user's explicit request** — never because a task looks obsolete to you.

Send independent calls in one message so they run concurrently, unless one depends on an id the previous call returns.

Then tell the user what moved, in one or two sentences. Not the whole document — they can read it on GitHub.
