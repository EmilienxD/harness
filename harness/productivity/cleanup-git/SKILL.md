---
name: cleanup-git
description: Explain local branches and worktrees, then confirm cleanup with you.
disable-model-invocation: true
argument-hint: "[--target <branch>]"
---

# Cleanup Git

1. Read the invocation hook's inventory. Account for **every local branch and worktree**, including detached, locked, missing, and dirty checkouts. Resolve the target from project instructions; `--target` is an explicit override. The hook's remote-default or main/master fallback is a starting point to verify. Complete missing or failed facts with read-only Git and GitHub commands. Local remote refs may be stale: explain that limitation or request a fetch before using them as deletion evidence.

2. Classify each case from its PR state, target and upstream divergence, uncommitted and untracked files, last commit, and latest non-ignored file modification. Inspect unique commits and diffs to explain where unprocessed work came from and what remains useful. A merged PR alone does not establish that later branch changes were processed. Squash merges may retain unique commit identities; inspect their content. Judge activity in context with **no fixed age threshold**. Treat unknown PR state and missing paths as uncertainty to investigate.

3. Present a compact inventory with each branch/worktree, supporting facts, unprocessed changes, and a concrete proposed action. Offer to clear `[AI]-in-progress` on issues you judge abandoned, with the issue and reasoning named. List missing Codex project trust entries; establish that each is a deleted worktree of this repository before proposing configuration changes. Paths from other repositories remain outside this cleanup. Preserve active, dirty, detached, or unexplained work in the proposal unless the user specifically chooses to discard it.

4. **Ask for explicit confirmation of the named actions.** Delete, prune, relabel, and remove configuration only after the user confirms the specific proposal. A request to inspect or run this skill is not approval to delete. Keep analysis read-only until confirmation; do not run a blanket prune or delete command as part of gathering facts.

5. Execute only confirmed actions. Recheck the affected worktree's dirty files and branch tip immediately before removal; changed facts need an updated proposal and confirmation. Use Git's worktree removal before deleting its branch, and remove only the approved Codex project entries while preserving other settings. On Windows, verify absolute deletion paths against the named worktrees and use one shell for filesystem operations. Report completed actions, preserved work, and any failed actions. Finish when every confirmed action has an observed outcome.
