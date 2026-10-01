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

The four headings are required. Run the steps and keep evidence outside the repository. After every expected result passes, run `test-workflows confirm <workflow>` from the checkout; it writes `verified_hash` and the per-file `verified_files` map, which stay as generated. Then run `test-workflows status`: its JSON lists each workflow's state and changed covered files. Exit 0 means all pass, 1 means stale, broken mapping, or invalid format, and 2 is a command error. Fix a broken `covers` mapping before confirming.

`status` finds workflows by their front matter in any tracked or non-ignored Markdown file; `--directory <folder>` narrows the search and `--root <checkout>` targets another checkout.

Inside a `/ship` loop, the implementer runs and reports each workflow with its result and evidence paths; the Lead owns workflow edits and confirmation, and the runtime controls Stop feedback and release. Outside a loop, the agent that ran the workflow confirms it. The workflow Stop check blocks once per user turn outside loops: complete confirmation or explain precisely why it remains unconfirmed.
