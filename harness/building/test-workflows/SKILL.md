---
name: test-workflows
description: Define manual end-to-end checks and confirm workflows after their covered code changes. Use when creating feature acceptance criteria or responding to a stale-workflow hook notice.
---

# Test workflows

A test workflow is a repeatable end-to-end acceptance check for a user-facing capability. It describes the starting conditions, the actions a user takes, and the observable results that prove the capability works, as text. It helps developers and agents maintaining a product end to end, where static test files are limited. A single test workflow run is heavy; test workflows must cover important situations only and stay simple and maintainable.

## Write a Test workflow

Write a markdown file per user-facing capability in the folder specified by project instructions, default `workflow/` next to unit tests. Use repository-relative `covers` globs that include every source code file whose behavior the workflow proves.

Use the template bellow:
<test-workflow-template>
---
covers: ["src/example/**/*.ts"]
verified_hash: null
---

## Preconditions

Required services, configuration, accounts, and initial data as bullet points.

## Steps

Sequential user actions as bullet points, each stating the intended operation. Don't reference code or name tools; this go stale really fast. Stay at the user's level.

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Potential Problems

Known and potential problems (errors, bugs, breaking UI) to expect and eliminate, as bullet points.
</test-workflow-template>

Every headings are required. Make the scenario specific enough that another user or agent can repeat it and decide whether each result passes.

## Run a workflow

Establish the preconditions, follow the steps, verify every acceptance criterion, and check for the listed problems. Save evidence outside the repository. Confirm only a passing run; report failures or blockers with evidence paths.

test-workflows help:

```text
Usage: test-workflows [--root <checkout>] [--directory <folder>] <command>

Commands:
  status              List workflow states and changed_files as JSON.
  confirm <workflow>  Record a passing run; write verified_hash and verified_files. <workflow> is the Markdown path relative to the repository.

Options:
  --root <checkout>   Use another checkout (default: current checkout).
  --directory <dir>   Limit status discovery (default: tracked/non-ignored Markdown).
  --help              Show CLI help.

States:
  passed   Covered files match the recorded verification.
  stale    Run the workflow again.
  broken   Fix covers: no files matched.
  invalid  Fix the workflow format.

Exit codes: 0 success; status returns 1 for stale/broken/invalid; 2 command error.
```
