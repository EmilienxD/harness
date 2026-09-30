---
name: test-workflows
description: Define manual end-to-end checks and confirm workflows after their covered code changes. Use when creating feature acceptance criteria or responding to a stale-workflow hook notice.
---

# Test workflows

Store one committed Markdown file per user-facing capability in the folder specified by project instructions, default `tests/workflow/`. Define success before implementation. Use repository-relative `covers` globs that include every file whose behavior the workflow proves.

```markdown
---
covers: ["src/example/**/*.py"]
verified_hash: null
---

## Preconditions
Required services, configuration, accounts, and initial data.

## Steps
Ordered browser interactions or CLI commands with concrete inputs.

## Expected results
Observable results for each step, including error cases that matter.

## Evidence required
Screenshots, output logs, or other evidence that demonstrates the results.
```

Run the steps and retain evidence outside the repository. After every expected result passes, run `test-workflows confirm <workflow>` from the checkout. The command stamps a platform-independent hash plus `verified_files`, its per-file hash inventory; preserve both generated fields. Then run `test-workflows status`. It returns JSON listing workflow state and changed covered files; exit 0 means all pass, 1 means stale, broken mapping, or invalid format, and 2 means a command error. Fix a broken `covers` mapping before confirming it.

The CLI discovers workflow front matter anywhere in tracked and non-ignored Markdown, including custom folders named by project instructions. `--directory <folder>` limits status discovery; `--root <checkout>` selects another checkout. Front matter supports JSON-style inline lists or YAML block lists for `covers`, quoted or plain scalar hashes, and the generated JSON `verified_files` map. Use the four headings exactly as shown.

Inside a `/ship` loop, the implementer runs and reports each workflow with its result and evidence paths; the Lead owns workflow edits and confirmation, and the runtime controls Stop feedback and release. Outside a loop, the agent that ran the workflow confirms it. The workflow Stop check blocks once per user turn outside loops: complete confirmation or explain precisely why it remains unconfirmed.
