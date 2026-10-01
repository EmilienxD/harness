# Resume a PR

1. Read the PR body, reviews, inline review threads, and comments, paginating as needed. Find the issue through `Refs #<n>` and its run directory; ask only when the issue is ambiguous.
2. Reuse the branch's worktree from `git worktree list --porcelain`, recreating it with the worktree script when missing. Keep the branch history and the recorded anchor. When the run directory or anchor is gone, settle that with the user before continuing.
3. Save the review requests to `<run>/review-<n>.md` and reference that file in the next prompt or feedback.
4. Pick the implementer with `harness loop lookup <recorded session>`:
   - waiting on a live Stop: send feedback with its token;
   - released, with context below `loop.freshContextPercent` or unknown, and no fresh-implementer rule applying: `harness loop resume <session> --file <feedback>`. Aboard reuses its terminal; a standalone terminal must be closed first;
   - working or taken over: wait for its next report;
   - otherwise: a fresh implementer, counting earlier ones in `run.json` against `loop.maxImplementers`.
5. Judge and close out as usual, including the single sync. Update the PR with `gh pr edit --body-file`, update the issue comment, mark a passing draft ready with `gh pr ready`, and apply the recorded auto-merge decision. A failing resumption stays a draft through the failure path.
