---
name: draft-issues
description: Write the issue breakdown approved in /map-issues to markdown files in .issues-gateway/ for the user to review and edit before publishing.
disable-model-invocation: true
---

# Draft Issues

> This skill is the step 2/3 of an issue publishing system from mapping to drafting to publishing. If `/map-issues` hasn't been called for this batch, stop and tell the user to do so.

Turn the breakdown approved in `/map-issues` into one markdown file per issue in `.issues-gateway/{batch-id}/`. Do not run `gh` or publish anything — that only happens in `/publish-issues`.

## Process

### 1. Batch id

Batch id (its directory under `.issues-gateway/` already exists — do not create it, and do not generate your own id):

!`dir="./.issues-gateway"; mkdir -p "$dir"; ok=0; for i in $(seq 100); do id=$(printf '%06x' "$((RANDOM<<16 ^ RANDOM))"); if mkdir "$dir/$id" 2>/dev/null; then echo "$id"; ok=1; break; fi; done; [ "$ok" -eq 1 ] || { echo "Error: failed to create a unique directory after 100 attempts." >&2; false; }`

Use this id for every file in this batch. If you see an error instead of an id, surface the problem to the user and stop; don't try any workaround.

### 2. Write one file per issue

For each approved issue, create `.issues-gateway/{batch-id}/issue-{i}.md` where `{i}` is the issue number starting at 0 in the order you plan to publish them (blockers before what they block). Do not spend time checking whether the folder exists or what it already contains — the directory was just created in step 1 — just write the files using multiple Write tool calls in parallel.

Use this template. The title is the first `# ` header. The line directly below it — the first non-empty line after the title — declares this issue's labels and must contain nothing else:

<issue-template>
# {Issue title}

> {difficulty-label}, {mode-label}

## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- `{batch-id}-{i}` of the blocking issue, one per line

Or "None - can start immediately" if no blockers.

</issue-template>

`{difficulty-label}` is `difficulty:low`, `difficulty:medium`, or `difficulty:high`, matching the difficulty chosen in `/map-issues`. `{mode-label}` is `mode:afk` or `mode:hitl`, matching the mode chosen in `/map-issues`. Example second line: `> difficulty:medium, mode:hitl`. `/publish-issues` parses this line to create and apply the labels — it tolerates extra surrounding whitespace, but don't add anything else to it, and don't skip it.

In "Blocked by", reference other issues in this batch by their `{batch-id}-{i}` token, wrapped in curly braces: `{a1b2c3-0}`. This works for references to issues in *this* batch only — a draft can't reference an issue from a different, unrelated batch. `/publish-issues` resolves these to real issue numbers once the referenced issue is published — don't try to resolve them yourself, and don't worry about getting the order perfect: unresolved references are retried automatically within a publish run, so an occasional misordering self-heals rather than getting silently stuck.

### 3. Hand off to the user

List the relative file paths you created (`.issues-gateway/{batch-id}/issue-{i}.md`) and tell the user they can review them. They can edit any file directly — title, labels, body, blockers — before publishing. Mention they can run `/publish-issues --dry-run` first to preview what would be created without touching the tracker, or `/publish-issues` to publish for real. Ask if they want changes.

Do NOT close or modify any parent issue.