---
name: test-workflows
description: Create or run test workflows. A test workflow is a repeatable end-to-end acceptance check for a user-facing capability. It describes the starting conditions, the actions a user takes, and the observable results that prove the capability works, as Markdown. It helps maintaining a product where static test files are limited. Use when defining or veryfing feature acceptance criteria.
---

A single test workflow run is heavy by definition; test workflows must cover important situations only and stay simple and maintainable. Run every `test-workflows` command below through `uvx --from git+https://github.com/EmilienxD/harness@d0c2b77165a680cd86b7668daf20940e17826b3f#subdirectory=harness/building/test-workflows test-workflows` followed by its arguments. Requires uv and Git; the first run downloads the pinned CLI into uv's cache.

## Write a Test workflow

Write one Markdown file per user-facing capability in the folder specified by project instructions, default `tests/workflow/`. Use the test title as its filename. Set repository-relative `covers` globs in its front matter to include every source code file whose behavior the workflow proves. `<stem>.manifest.json` is auto-managed by the CLI, verifying covered file hashes.

Use this Markdown template:
<test-workflow-template>
---
covers: ["src/example/**/*.ts","src/example/**/*.py"]
---

## Preconditions

Required services, configuration, accounts, and initial data.

## Steps

Sequential user actions, each stating the intended operation. Don't reference code or name tools; this go stale really fast. Stay at the user's level.

## Acceptance Criteria

- Criterion 1
- Criterion 2
- Criterion 3

## Potential Problems

Known and potential problems (errors, bugs, breaking UI) to expect and eliminate, as bullet points.

</test-workflow-template>

Steps and Acceptance Criteria headings and sections are required. Preconditions and Potential Problems are optional. Make the scenario specific enough that another user or agent can repeat it and decide whether each result passes.

## Run a workflow

Run `test-workflows status` explicitly when verifying covered changes, as you would run unit tests. Use the reported workflow states and changed files to choose the checks to run.

Establish the preconditions, follow the steps, verify every acceptance criterion, and check for the listed problems. Save evidence outside the repository. Confirm only a passing run; report failures or blockers with evidence paths.

```bash
# Look up commands and options.
test-workflows --help

# List workflow states and changed files in the current checkout.
test-workflows status

# Check workflows in the folder specified by project instructions.
test-workflows --directory tests/workflow status

# Check workflows in another checkout.
test-workflows --root /path/to/checkout status

# Record a passing run using the workflow's repository-relative Markdown path.
test-workflows confirm "tests/workflow/example-capability.md"
```

Use the CLI to manage verification; reading or editing the manifest is a bad practice.
