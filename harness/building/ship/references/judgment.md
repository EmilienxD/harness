# Judge reports

A report is the implementer's verification: judge it as written, without rerunning its checks. The stub contract and workflow status in closeout stay yours.

Take the first rule that applies:

- **Takeover or expiry.** A takeover notice, or feedback rejected as stale or taken over, voids your verdict: wait for the next report. A wait-expired notice ends the loop through [the failure path](closeout.md#failure).
- **Accept** when every stub test and every required workflow shows an explicit pass and an evidence path, with no open blocker or contradiction. Keep the implementer waiting and go to [closeout](closeout.md).
- **Needs decision** when a blocker requires the user's choice: failure path.
- **Related blocker** with a known, simple fix: feedback.
- **Unrelated blocker.** Create an `[AI]-help-wanted` issue for the prerequisite and link it as blocking the current issue with `gh api graphql` and `addBlockedBy(input:{issueId:<current node ID>,blockingIssueId:<new node ID>})`; `issue-context` returns node IDs. With `[AI]-auto-merge`, release the implementer, deliver the prerequisite through its own loop under the same auto-merge decision (label it), then sync the original branch and resume. Otherwise take the failure path. Dependency cycles and ambiguous fixes go to the user.
- **Fresh implementer** when context usage is at or above `loop.freshContextPercent` (unless the remaining fix is small and localized), the report repeats the previous failures, the report is vague, contradictory, off-scope, or claims results without evidence, or this implementer's `loop.maxFeedback` is spent. When that would exceed `loop.maxImplementers`, take the failure path instead.
- **Feedback** otherwise: name each failing criterion, the expected behavior, and the evidence the next report must show.

Unknown context usage skips only the context rule. The runtime's percentage is the last request's usage and resets after compaction; use it as given.

## Commands

- Feedback: `harness loop feedback <session> --wait-token <token> --file <run>/feedback-<n>.md`, with the token of the report you judged. Count each round in `run.json`.
- Release: `harness loop release <session> --wait-token <token>`. The terminal stays open for the user.
- State: `harness loop lookup <session>` returns `active`, `wait`, `context_usage`, and `last_report`.

## Fresh implementer

Append the report's problems to `problems.md`, save the report as `report-<n>.md`, release the current implementer, and confirm with `lookup` that it is inactive. Launch the next one with the fresh section of [the prompt template](implementer-prompt.md); one implementer is active per worktree.

## User intervention

User messages to either agent arrive with the next report; account for them in the verdict. An interrupt pauses the loop: a working implementer continues to its next report, and an interrupted Lead finds the pending report at its next prompt. Esc on a waiting implementer is a takeover.
