# Close out

Run these in order after an all-pass report; the implementer keeps waiting until step 5.

1. **Sync once.** Fetch and merge the latest target into the branch, and commit the merge. When it brings changes, send one confirming round: the implementer resolves conflicts with `resolving-merge-conflicts` while you run the Git commands, then reruns the affected tests and every required workflow. Judge that report as usual; this round is outside `loop.maxFeedback`. Later target moves surface as PR conflicts.
2. **Stub contract.** Run `ship-stubs check --root <worktree> --base <base-sha> --anchor <anchor-sha>`, adding `--unit-directory` and `--workflow-directory` for custom folders. Exit 0 passes, 1 lists violations, 2 is an error. It reads Python; for other languages, compare each test inventory with the anchor through the language's own collection. The contract: every anchored test keeps its file, name, signature, decorators, and docstring and now has a real body; existing tests stay intact; the set of tests, skips, and collection settings is unchanged. Send violations as feedback; a change to the criteria themselves goes to the user.
3. **Workflows.** Confirm each workflow the report shows passing with `test-workflows --root <worktree> confirm <workflow>`, then run `test-workflows --root <worktree> status`. A stale or broken workflow that covers files in the target-to-branch diff goes back as feedback. Disclose unrelated stale workflows in the PR.
4. **Publish.** Review the staged file list, commit, push, and open the PR against the target with `gh pr create --body-file <run>/pr-body.md`:

   ```markdown
   ## What landed
   ## Why
   ## How
   ## Test on staging
   <numbered steps>
   ## Suggested tools
   <tools that would have helped, or "None">

   Refs #<n>
   ```

   The issue stays open, so the title, body, and commit messages reference it with `Refs #<n>` only, never `Closes`, `Fixes`, or `Resolves`.
5. **Outcome.** Comment on the issue with the PR link and outcome. With `[AI]-auto-merge`, merge with the project's method once GitHub allows it; a blocked merge goes back through the loop or the failure path. Release the implementer with its current token.

## Failure

On a needs-decision blocker, an exhausted cap, or a wait-expired notice:

1. Check with `harness loop lookup` that the implementer is inactive; a working implementer keeps the worktree until its next report or exit.
2. Commit the work and open a draft PR with the body above plus the failing criteria and evidence paths.
3. Add `[AI]-needs-decision` and comment on the issue with the draft link and one precise question.

When GitHub or an empty diff prevents the draft, report the exact error with the worktree and run directory paths.
