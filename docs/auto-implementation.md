# Auto-implementation workflow

**Status:** Implemented
**Date:** 2026-07-31

This document is the authoritative contract for aboard's automatic implementation workflow. It
**supersedes** [`initial-spec.md`](./initial-spec.md) §7.5 (auto-review tri-state, reviewer → fixer
hand-off), §9.3 steps 3–5 (the implementer commits, opens, and merges its own PR), §9.5 (`reviewer`),
and §9.6 (`fixer`). Everything else in the spec still holds and is load-bearing here — in particular
the four-label model (§7.2), the visibility invariants (§0), hook self-guards (§8), and the rule that
the bridge is the only creator of agents (§1.4.5).

The write lease is **out of scope**. Its process is being reworked separately; nothing in this
document should be read as changing it, and an implementer of this design should take the lease
exactly as it is.

---

## 1. Decision

**The extension owns the loop; agents only produce content.**

An `AutoRunEngine` in the extension host walks one `spec` issue's children. For each child it
launches exactly one implementation agent (plus, optionally, one review agent) and performs **every
git and GitHub side effect itself**. The Manager triggers a run and is told about its progress; it
does not drive it, and `implementer` and the pr-doctors leave its delegation surface entirely.

This inverts spec §9.3, where the implementer ran `git commit`, `gh pr create`, and `gh pr merge`
from its own prompt contract. Three reasons:

1. **Determinism.** A branch name, commit message, PR title, and `Closes #N` trailer derived from
   the issue are correct by construction. An agent producing them is a sampling operation that
   drifts, and the drift is invisible until someone audits the repo.
2. **Cost.** Every `git`/`gh` round trip inside an agent is tokens spent on plumbing in the most
   expensive context in the system, and it is plumbing with exactly one correct answer.
3. **Recoverability.** Side effects performed by the extension are recorded against the run's phase
   state, so an interrupted run resumes by checking postconditions. Side effects buried in a dead
   agent's context are not recoverable at all.

### Non-goals

- Parallel issue processing. One worktree, one branch: issues are serial. Worktrees are out of scope.
- Autonomous spec authoring. A run consumes specs; it never creates or edits one.
- Conflict resolution. Serial processing off an updated default branch is what makes conflicts a
  non-event; if one occurs anyway the run stops rather than resolving it.
- Any change to the write lease.

---

## 2. Agent roster changes

| Type | Before | After |
| :-- | :-- | :-- |
| `implementer` | Implements, commits, opens PR, merges | Implements only. Must not run `git commit`, `git push`, or `gh`. |
| `reviewer` | Read-only, posts inline findings | **Removed** |
| `fixer` | Write-capable, addresses review threads | **Removed** |
| `pr-doctor-afk` | — | **New.** Automated, write-capable. Reviews the diff and applies fixes directly. |
| `pr-doctor-hitl` | — | **New.** Interactive, write-capable. Reviews the diff, proposes findings, applies them on the user's word. |

The two pr-doctors replace the reviewer/fixer pair because a review agent that hands its conclusions
to a separate fixer forces that fixer to re-read every file the reviewer already read, in order to
act on reasoning it did not form. That is the worst available token trade, and avoiding it is the
entire point of the merge.

They differ in **when they may act**, not in what they can do. Both read the diff, both can edit.
`pr-doctor-hitl` simply must present its findings and wait for the user's response before touching
anything — and because it already holds the diff and its own analysis in context, applying the user's
decision costs nothing extra. That is the property the old reviewer/fixer split destroyed.

They are two agent definitions rather than one type launched two ways because the `--agent` /
`--tools` exclusivity invariant forbids overriding tools for a type whose definition declares
`tools:`, and "read-only by instruction" is a suggestion, not a restriction.

### Delivery classification

| Type | Automated / interactive | `ResultDelivery` | In fleet after terminal closes |
| :-- | :-- | :-- | :-- |
| `implementer` (auto-run) | automated | `tool-result` | yes, reconciled |
| `pr-doctor-afk` | automated | `tool-result` | yes, reconciled |
| `pr-doctor-hitl` | interactive | `none` | no, forgotten |

**No new `ResultDelivery` variant is needed.** `recordResult` parks a `tool-result` outcome in
`blockingResults` and `DelegationCoordinator.run()` resolves on it; the engine is in-process async
code, so it genuinely is the blocked caller that mode describes. `reportsResult()` stays true
(mode ≠ `none`), so a terminal closed mid-step is reconciled into a failed step instead of being
silently forgotten. `mailbox` would be wrong: `ManagerStopService.poll` blocks the Manager's Stop
hook while any mailbox-delivering agent is active, which would hang the Manager for the whole run.

`pr-doctor-hitl` delivers nothing, and the run's continue signal for a HITL issue is the pull
request's resolution, never that agent's completion.

---

## 3. Trigger surface

One primitive, three entry points, all converging on `AutoRunEngine.start()`:

| Entry point | Shape |
| :-- | :-- |
| `mcp__aboard__start_auto_run` | Manager's MCP tool. Non-blocking. No arguments. |
| `/auto` | Intercepted in `ManagerPromptService`, exactly as `/brainstorm` and `/raw` are today. Takes no arguments; trailing text is matched and dropped, never forwarded. Backed by a scaffolded `auto` skill so it appears in the slash-command list. |
| `aboard.startAutoRun` | Panel/palette command, so a run is startable with no Manager alive. |

Only one run exists at a time. `start` while a run is active returns the active run's state instead
of starting a second one, and says so.

### The MCP tool is non-blocking

Three independent reasons:

- A foreground MCP call is bounded by `ABOARD_MCP_TIMEOUT_SECONDS` (3600). A multi-issue run exceeds
  that routinely and a HITL run can span days.
- Blocking pins the Manager's turn, so the user cannot talk to it while the run proceeds — precisely
  the failure `run_in_background` exists to avoid.
- The run must outlive the Manager. A Manager crash, `/clear`, or context exhaustion must not abort a
  run mid-merge.

`start_auto_run` returns immediately with the resolved plan so the Manager can tell the user exactly
what is about to happen:

```jsonc
{
  "runId": "run_01H…",
  "spec": { "number": 12, "title": "Offline sync" },
  "reviewMode": false,
  "scope": "spec",
  "issues": [
    { "number": 34, "title": "Add retry backoff", "disposition": "afk",  "branch": "aboard/34-add-retry-backoff" },
    { "number": 35, "title": "Migrate the queue",  "disposition": "hitl", "branch": "aboard/35-migrate-the-queue" }
  ],
  "skipped": [
    { "number": 36, "reason": "unclassified: neither afk nor hitl" },
    { "number": 37, "reason": "blocked by open #35" }
  ]
}
```

If the run cannot start, it returns `{ "started": false, "reason": … }` and launches nothing. Refusal
reasons are in §5.1.

---

## 4. Progress reporting

Every phase transition enqueues **one bounded line** through `FleetRegistry.enqueueNotification`,
drained by the `UserPromptSubmit` hook on the user's next message. Overflow is already summarized by
`drainNotifications`; no new machinery is required.

This is deliberately *pull on the user's next message*, not push. If the user is away for a whole AFK
spec, the Manager learns the outcome when they return — which is what "AFK" means. It also keeps the
run from injecting turns into a conversation the user is having.

Message shapes (keep them this terse; they are read in bulk):

```
auto-run: started spec #12 "Offline sync" — 2 issues (1 afk, 1 hitl), review off.
auto-run: issue #34 implemented on aboard/34-add-retry-backoff.
auto-run: issue #34 committed (a1b2c3d) and opened PR #56.
auto-run: issue #34 merged, issue closed.
auto-run: issue #35 is hitl — PR #57 is open and waiting for you. The run is paused.
auto-run: PR #57 merged by you; continuing.
auto-run: stopped at issue #35 (implementer failed: context-exhausted). Branch and work left in place.
auto-run: spec #12 complete (2 issues). 3 open specs remain — run /auto to continue.
```

The run's live state is also surfaced in the UI: a status-bar item (`Auto-run: spec #12 (2/5)`) and
an `aboard.stopAutoRun` command. A third tree view is not added; the existing panel already carries
its own design and a run is one line of state.

---

## 5. Run model

### 5.1 Preconditions for starting

Checked in this order; the first failure refuses the run and launches nothing:

1. **The workspace is a git repo with a resolvable default branch and an authenticated `gh`.**
2. **The working tree is clean.** This is binding: the engine stages with `git add -A`, so a dirty
   tree would sweep the user's unrelated work into an automated commit. Refuse with the list of dirty
   paths rather than trying to be clever about which changes belong to whom.
3. **No run is already active.**
4. **An open issue labelled `spec` exists.**
5. **That spec has at least one processable child** (open, `afk` or `hitl`, not blocked).

### 5.2 Selection

- **Spec:** the open issue labelled `spec` with the earliest `createdAt`. Ties break on lowest
  number. "Oldest" is by creation, not by update — a spec being edited is not a spec being deprioritized.
- **Issues:** that spec's sub-issues, via the GraphQL `parent` edge already parsed into
  `IssueSnapshot.parentIssueNumber`. Open only, ascending by number.
- **Skipped — unclassified:** an issue labelled neither `afk` nor `hitl` is skipped and reported,
  never guessed at. Spec §7.2 is explicit that unclassified is a legitimate third state and that the
  system flags rather than infers.
- **Deferred — blocked:** an issue with an open `blockedBy` dependency is deferred. The remaining set
  is **re-evaluated after every merge**, because a merge can unblock a later sibling. An issue still
  blocked when the run reaches the end of the list is reported as unprocessed, not treated as failure.

Selection is re-derived from GitHub at each issue boundary. The plan returned at `start` is a
forecast, not a commitment.

### 5.3 Serial, not concurrent

Issues are processed one at a time. This is not a tuning choice: one worktree holds one branch.

### 5.4 Branch naming and base

`aboard/<issue-number>-<slug>`:

- slug = title lowercased, every run of non-`[a-z0-9]` collapsed to `-`, leading/trailing `-`
  trimmed, truncated to 40 characters at a `-` boundary (never mid-word), empty slug → `issue`.
- The number is part of the name because slugs collide and because a branch must be greppable back
  to its issue.

**Before each issue** the engine runs `git fetch origin`, checks out the default branch, and fast-forwards
it. Issue *n+1* therefore branches from a default branch that already contains issue *n*'s merge,
which is what makes dependency ordering meaningful and conflicts a non-event. The branch is created
and checked out **before launch**, so the agent starts on it and never runs `git checkout` itself.

---

## 6. Phases

Per issue: `branch → implement → commit → pr → review? → await-approval? → merge → cleanup`.

Every phase is **idempotent and postcondition-checked**. This is a hard requirement, not an
optimization: it is the only thing that makes resume safe.

| Phase | Precondition (skip if already true) | Action | Postcondition | On failure |
| :-- | :-- | :-- | :-- | :-- |
| `branch` | branch exists and is checked out | fetch, update default, `git checkout -b` | branch checked out, tree clean | stop run |
| `implement` | — | launch `implementer`, await result | tree dirty on the right branch | stop run |
| `commit` | HEAD carries a commit **and** the remote ref matches | verify branch, `git add -A`, commit, push `-u` | commit pushed | stop run |
| `pr` | an open PR exists for the branch | `gh pr create` | PR open with `Closes #N` | stop run |
| `review` | review mode off, or already reviewed | launch pr-doctor (see §7) | doctor finished (afk) / handed off (hitl) | stop run |
| `await-approval` | disposition is `afk` | poll until PR merged or approved | PR resolved | user closed PR → stop |
| `merge` | PR already merged | `gh pr merge --squash --delete-branch` | PR merged, issue closed | stop run |
| `cleanup` | — | close terminals, return to default branch | ready for next issue | log, continue |

**"Stop run" means stop, not skip.** A failing implementer usually means the issue or the spec is
wrong, and the siblings share that spec. Continuing would multiply one bad premise across a whole
spec's worth of PRs. The branch, any commit, and any PR are left exactly as they are.

### 6.1 `commit` details

- **Verify the current branch first.** The implementer is told not to touch git, but it has `Bash`.
  A mismatch stops the run rather than committing to the wrong place.
- **Empty diff is a failure**, reported as "the implementer produced no changes". No commit, no PR.
  The exception is a clean tree that already carries this issue's commit: commit and push are two
  effects that fail independently, so a push that failed after a successful commit must resume by
  retrying the push, not by reading the now-clean tree as "nothing was implemented". That is why
  `commitPushed` is a real comparison against `refs/remotes/origin/<branch>` and not an alias for
  `hasCommit`.
- **A pull request this run already knows about is reused, never re-opened.** The reducer routes a
  second dirty tree — a doctor's fixes — back through this same phase, and the head-branch lookup
  only finds *open* pull requests, so a merged or closed one would otherwise spawn a second.
- Commit subject: the issue title, truncated to 72 characters. Body: `Implements #<n>.` plus the
  agent id for traceability.
- `Closes #N` goes in the **PR body**, not the commit message, because PR-based closure is what
  `closingIssuesReferences` reads and what the merge must trigger.
- Fixes from a pr-doctor land as a **second commit** on the same branch, made and pushed the same way.

### 6.2 `pr` details

- Title: the issue title.
- Body: the implementer's `lastAssistantMessage`, capped at 4000 characters, followed by a blank line
  and `Closes #<n>`. That message is already captured in `WorkerResult` and is exactly a summary of
  what the agent did — the extension cannot write a better one, and asking an agent for one costs a
  turn.
- Merge strategy: `aboard.autoRun.mergeStrategy`, default `squash`. Squash because one issue is one
  logical change even when the engine made two commits.

### 6.3 The extension does not approve PRs — and cannot

**GitHub refuses `gh pr review --approve` on a pull request opened by the same account.** The
extension opens PRs with the user's own `gh` credentials, so:

- **AFK:** there is no approve step. The engine merges directly. If branch protection *requires* a
  review, the merge fails and the run stops with that explicit message — auto-run cannot satisfy a
  review requirement without a second identity, and it must say so rather than appear stuck.
- **HITL:** for a solo repository the user cannot approve their own PR either, so
  `reviewDecision === "approved"` will never fire. The **primary continue signal is therefore the
  user merging the PR**, which spec §7.3 already defines as the approval gesture. Approval is kept as
  a secondary signal for multi-person repositories, where the extension then performs the merge.

This is the single most likely thing to be re-derived incorrectly by someone implementing from the
old spec text. It is not a limitation to work around; it is the reason §7.3's "the user's merge is
the approval" was right in the first place.

---

## 7. Review mode

`aboard.autoRun.review`, default `false`. Automated review stays opt-in — spec §7.5's invariant is
unchanged, only its shape is. The tri-state `aboard.review.autoReview: "never" | "hitl" | "all"` is
retired; review now applies to both dispositions when enabled, and only the doctor's *authority*
differs.

| Disposition | Review off | Review on |
| :-- | :-- | :-- |
| `afk` | commit → PR → merge | commit → PR → **`pr-doctor-afk`** → commit fixes → merge |
| `hitl` | commit → PR → wait | commit → PR → **`pr-doctor-hitl`** → wait |

### 7.1 `pr-doctor-afk` (automated, write-capable)

- Model: opus. Tools: as `implementer`.
- Launch prompt, resolved by the bridge: the PR diff, the issue body, the parent spec excerpt, the PR
  number, and the branch name.
- Contract: review the diff against the issue contract, apply fixes directly, stop. Do **not** commit,
  push, merge, or post review comments — the engine commits, and a finding it fixed itself is not
  worth a comment thread.
- Its result is the summary the engine appends to the fix commit body.

### 7.2 `pr-doctor-hitl` (interactive, write-capable)

- Model: opus. Tools: as `implementer`, plus `AskUserQuestion`.
- Same launch prompt as `pr-doctor-afk`.
- Contract: review the diff, **present the findings to the user and stop**. Apply changes only on the
  user's word, and then only the ones they agreed to. The user may accept the summary, adjust it, or
  redirect it entirely; the diff and the analysis are already in context, so acting on that answer is
  cheap. Do not commit, push, or merge.
- Interactive: terminal focused and handed over, no result delivered.
- The implementation terminal stays open alongside it, so the user can read what was built while
  discussing what to change.

Their system prompts should be near-identical, with the HITL one adding the propose-and-wait contract.
Divergence between them is a bug — the whole design rests on them being the same reviewer with
different permission to act.

### 7.3 Commit safety during review

The user may be typing into the still-open implementation terminal while a pr-doctor works. The
engine must therefore re-read the working tree immediately before the fix commit rather than assuming
it contains only the doctor's changes, and report what it is about to commit in the notification.

### 7.4 Capturing a hitl doctor's fixes

`pr-doctor-hitl` applies changes only when the user says so, which is minutes after it launched and
entirely outside the engine's control. Nothing else in the loop is watching the tree at that point,
so the engine commits and pushes any uncommitted work on the issue's branch **on every poll tick of
the HITL wait**, before it reads the pull request's state. Without this the user merges a pull
request that does not contain the changes they just approved, and the work is stranded uncommitted —
silently, because the merge itself succeeds.

This is deliberately not conditioned on review mode. The user may equally have edited in the still-open
implementation terminal, and committing to the branch they are about to merge is what they expect. It
is always announced, because a commit nobody explicitly asked for must not be a silent one. Work found
on the *wrong* branch is left alone and logged: committing it would put it somewhere nobody is reviewing.

A merge that lands between two ticks still races the capture. The poll interval bounds the window;
"continue now" flushes it on demand.

---

## 8. HITL gating

After the PR is opened (and reviewed, if enabled), a HITL issue's run **waits**. The implementation
terminal stays open so the user can interrogate what was built.

- **Continue signal:** the PR is merged (primary — see §6.3), or its `reviewDecision` becomes
  `approved` by another account, in which case the engine merges.
- **Detection:** poll `getReviewState` / `getPullRequest` every 30s while a wait is outstanding, plus
  an immediate poll on VS Code window focus. A panel command offers "continue now".
- **On resolution:** close the implementation and doctor terminals, return to the default branch, and
  proceed to the next issue.
- **PR closed unmerged:** the user rejected the work. The run stops, the issue stays open, the branch
  is left alone, and the rejection is reported.

### 8.1 Continue automatically after a HITL issue

**Yes.** The approval *is* the explicit user gesture; requiring a second one to resume makes the user
act twice for one decision, and the run is already visible and stoppable.
`aboard.autoRun.pauseAfterHitl` (default `false`) exists for users who want the harder brake.

### 8.2 One spec per run

**Stop after one spec.** `aboard.autoRun.scope: "spec" | "all"`, default `"spec"`.

A spec is the natural human review unit, and the run's irreversible acts (merging PRs, closing
issues) should have a bounded blast radius per invocation. Token and quota cost points the same way:
a run that silently continues into the next spec can consume a subscription window before the user
sees the first result. On completion the engine reports how many open specs remain and that `/auto`
continues, which costs one gesture and buys a re-prioritization point.

---

## 9. `review_pr` is reframed as "reopen the session for the open PR"

`review_pr` no longer launches a reviewer. It becomes the way back into work already in flight:

1. Find the latest open pull request. None → report that and stop; nothing is launched.
2. Pick the agent that owns it: the **`implementer`** when review mode is off, the **pr-doctor** when
   it is on.
3. Terminal still open → **focus** it. Terminal closed → **resume** the session
   (`claude --resume <sessionId>`) into a new terminal.
4. Hand it to the user, who sees what the agent did and continues from there — fixing, committing,
   and closing the PR themselves.

This is a handoff, so it returns no result; the Manager learns what happened from the
`UserPromptSubmit` drain on the user's next message. Resume is safe because the agent has already
run, so a transcript exists — the closed-before-first-message case that breaks `--resume`
(`architecture.md`) cannot apply to a worker that produced a commit.

Reachable three ways, like the auto-run trigger: the `review_pr` MCP tool, a `/review-pr` skill, and
a panel command. If the owning session is unknown (extension restarted with no record), fall back to
launching a fresh `pr-doctor-hitl` against the PR and say so.

---

## 10. Settings

```jsonc
"aboard.autoRun.review":          false,              // launch a pr-doctor after each implementation
"aboard.autoRun.scope":           "spec",             // "spec" | "all"
"aboard.autoRun.pauseAfterHitl":  false,
"aboard.autoRun.mergeStrategy":   "squash",           // "squash" | "merge" | "rebase"
"aboard.autoRun.pollSeconds":     30                  // HITL wait poll interval
```

`aboard.review.autoReview` is removed. All of these resolve through the existing three-layer
configuration scheme (VS Code workspace → `.aboard/settings.json` → default) with no special cases.

---

## 11. Persistence and resume

The run record persists to `.aboard/runtime/auto-run.json` — gitignored, matching the existing
runtime convention. It contains **no prompt text**:

```jsonc
{
  "version": 1,
  "runId": "run_01H…",
  "specNumber": 12,
  "issueNumbers": [34, 35],
  "currentIssue": 35,
  "phase": "await-approval",
  "branch": "aboard/35-migrate-the-queue",
  "prNumber": 57,
  "reviewMode": false,
  "scope": "spec",
  "reviewedIssues": [34],
  "startedAt": "2026-07-31T09:12:04.221Z"
}
```

**Resume is explicit, never automatic.** On activation with a record present, the extension offers
**Resume / Discard** and does nothing until answered. Auto-resuming would launch a write-capable
agent into a workspace nobody has looked at since the crash, with no human present — exactly what the
visibility invariants exist to prevent.

The record is a **resume hint, not a source of truth**. On resume the engine re-derives everything
from git and GitHub — does the branch exist? is the tree dirty? is there a commit? an open PR? is it
merged? is the issue closed? — and re-enters at the first unsatisfied postcondition. A record that
disagrees with the repository loses. In practice this means the reducer always walks from the *first*
phase and skips satisfied postconditions, rather than resuming at `phase`: starting at the recorded
phase is what would let a stale record win. `phase` is therefore diagnostic only.

Four fields are read back, and each earns it by answering something the repository cannot:

- **`prNumber`** seeds the lookup for the issue it was recorded against. A merged pull request no
  longer answers a head-branch query, so without the seed a resume can open a second one for work
  that already landed. A number that resolves to nothing is treated as no pull request, so a stale
  record cannot skip the `pr` phase either.
- **`reviewMode`** and **`scope`** belong to the run, not to the current settings. A setting changed
  mid-run must not retarget a run already in flight, and a resumed run must behave as the run it is
  resuming.
- **`reviewedIssues`** is the one genuinely non-derivable fact: a review that found nothing leaves no
  commit, and the in-memory owner map is empty after a restart. Absent or stale, the issue is
  reviewed again — the safe direction to be wrong in.

---

## 12. Interruption handling

| Event | Behavior |
| :-- | :-- |
| Implementation terminal closed mid-phase | `terminalClosed` already reconciles to `killed`/`crashed`. The step fails: **no commit, no PR.** The branch and its uncommitted work are left on disk untouched. Run stops and reports. |
| Agent crashes / context exhausted | Step fails, run stops. Does **not** skip to the next issue (§6). |
| Empty diff after implementation | Failure: "the implementer produced no changes". No commit, no PR. |
| Agent left the repo on the wrong branch | Detected in `commit`'s branch check. Run stops before writing anything. |
| `gh` failure on PR create or merge | Run stops. Branch and commit stay; the phase is re-runnable on resume because it checks its postcondition. |
| Merge blocked by branch protection | Run stops with the explicit "auto-run cannot approve its own PR" message (§6.3). |
| VS Code shutdown or window reload | Record persists; explicit Resume/Discard on next activation (§11). |
| User stops the run (`aboard.stopAutoRun`) | Current agent's terminal is left open, nothing is rolled back, state is reported. Stop is a pause with no resume promise, not an undo. |

Nothing in this workflow deletes or reverts user-visible work. Branches, commits, and PRs created
before a failure stay; the engine's job on failure is to stop cleanly and say exactly where it stopped.

---

## 13. Module impact

**New**

- `src/domain/auto-run.ts` — pure phase reducer. No `vscode`, no process, no clock, no I/O. Given a
  run record and observed repository facts, returns the next step or the terminal outcome.
- `src/auto/engine.ts` — the driver. Owns the loop, performs effects through injected boundaries,
  emits notifications, persists the record.
- `src/git/client.ts` — a real git boundary: `fetch`, `defaultBranch`, `checkout`, `createBranch`,
  `status`, `add`, `commit`, `push`, `currentBranch`. The ad-hoc `execFile("git", …)` calls in
  `bridge/lifecycle.ts` and `bridge/worker-hooks.ts` move behind it.

**Changed**

- `domain/contracts.ts` — `reviewer`/`fixer` out, `pr-doctor-afk`/`pr-doctor-hitl` in; the
  MCP-launchable type list splits from the full type list.
- `bridge/delegation.ts` — `expectsUncommittedTree` on `DelegationLaunchInput`, set only by the engine.
- `bridge/lifecycle.ts` — `stop()` skips the `no-commit` check when that flag is set. Today a dirty
  tree is a `no-commit` **failure**; for an auto-run implementer it is the expected **success** state,
  and an empty diff is the failure. This is a property of the agent's contract, not of where its
  result goes, which is why it lives on the launch input and not on `ResultDelivery`.
- `bridge/mcp.ts` — add `start_auto_run`; reframe `review_pr` (§9); `implementer` and both pr-doctors
  leave `run_agent`'s enum.
- `bridge/manager-hooks.ts` — `/auto` and `/review-pr` interception alongside `/brainstorm` and `/raw`.
- `github/client.ts` — add sub-issue listing by parent, spec listing by `createdAt`, PR create/merge.
- `github/review.ts` — `ReviewCoordinator.routeFixes` and `AutoReviewSetting` removed.

**Scaffold**

- `agents/implementer.md` — contract ends at "the working tree contains the change"; explicit
  prohibition on `git commit`, `git push`, and `gh`.
- `agents/reviewer.md`, `agents/fixer.md` — deleted.
- `agents/pr-doctor-afk.md`, `agents/pr-doctor-hitl.md` — added.
- `skills/auto/`, `skills/review-pr/` — added.

**Docs**

- `initial-spec.md` §7.5, §9.3, §9.5, §9.6 amended to point here.
- `AGENTS.md` skill-ownership list gains `auto` and `review-pr`.

---

## 14. Verification targets

- **Reducer:** every transition, and every postcondition-already-satisfied short circuit. Pure, no
  fakes needed.
- **Slug normalization:** collisions, unicode titles, punctuation runs, the 40-character boundary
  landing mid-word, empty result.
- **Selection:** oldest spec by `createdAt`, tie on number, sub-issue ordering, unclassified skipped
  with reason, blocked deferred and re-evaluated after a merge.
- **Preconditions:** a dirty working tree refuses the run and names the dirty paths; a second `start`
  returns the active run.
- **AFK path** end to end against fake git/gh boundaries, with and without review mode.
- **HITL path:** stops at the gate; continues on merge; continues on third-party approval; stops on
  PR closed unmerged.
- **`no-commit`:** not raised when `expectsUncommittedTree` is set; still raised for a manually
  delegated write-capable agent.
- **Interruption:** terminal closed mid-implement leaves no commit and no PR; resume re-enters
  correctly from each phase, including when the repository disagrees with the persisted record.
- **`review_pr`:** no open PR launches nothing; open PR focuses a live terminal, resumes a closed one,
  and delivers no result either way.
- **Notifications:** one line per transition, and the bounded-summary path when many accumulate.
- **HITL fix capture:** a doctor's changes applied mid-wait are committed and pushed *before* the
  merge is observed, and are announced.
- **Resume specifics:** a commit that failed to push resumes by pushing; a persisted `prNumber` that
  resolves to nothing does not skip the `pr` phase; a resumed run keeps its own `reviewMode`; a
  recorded review is not repeated.
