---
name: update-todo
description: Evolve the aboard project roadmap issue while keeping it concise and directional
argument-hint: "[roadmap change]"
disable-model-invocation: true
---

The current roadmap is already in your context, in the `## Roadmap` section of the aboard state block delivered at session start. Read it there; there is no fetch step.

Apply `$ARGUMENTS` as an evolution of that roadmap: add newly discovered work, reprioritize what is already there, remove what is obsolete. Keep it concise and directional — it is a roadmap, not a duplicate of the specification issues it points at.

Write the full replacement body, including the parts you did not change, with a short audit reason:

```
uv run --no-project "$ABOARD_CLI" todo --reason "<what moved and why>" --body - <<'BODY'
<the full roadmap>
BODY
```

Then tell the user what moved, not the whole document.
