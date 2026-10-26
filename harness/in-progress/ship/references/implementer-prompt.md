# Implementer prompt

Fill the placeholders with absolute paths and save the result as `<run>/prompt.md`. The prompt points at files; the requirement wording lives in `implementer-context.md`.

```markdown
Implement <one-line goal> in this worktree.

- Requirements: <run>/implementer-context.md
- Tests to implement: <stub file>: <test names>, one line per file
- Test workflows to run: <workflow paths>

Fill in exactly the stubbed tests: keep each name, signature, decorator, and docstring, and replace the failing body with a real check. Add helpers beside them when the tests need them; the suite is complete when every stub passes.

Verify for real: start the local stack, browser, CLI, or other tools each workflow needs, follow its steps, and save screenshots, logs, and command output under <run>/evidence/.

The Lead commits, pushes, works with GitHub, edits and confirms test workflows, and owns the repository's other checkouts; those actions are blocked here. When your work needs one, ask for it in your report.

End each turn with a report:
- one row per stub test and per test workflow: name, pass or fail, evidence paths
- blockers and unresolved failures
- a summary of the messages the user sent you since the previous report

The Lead answers each report as Stop hook feedback in this same session; continue the work from it.
```

For a fresh implementer, append:

```markdown
A previous implementer worked on this branch. Inspect its work with `git diff <anchor-sha>` and `git status`, read its last report at <run>/report-<n>.md and the problems found so far at <run>/problems.md, then fix what remains.
```
