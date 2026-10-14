---
name: cleanup-git
description: User-invoked only. Agents must not invoke this skill on their own. Inspect merged local branches and worktrees, then approve cleanup.
disable-model-invocation: true
---

# Cleanup Git

The installed hook or Pi extension supplies a **Git cleanup inventory**, describing every local branch and worktree. Pi supports `/cleanup-git` and `/skill:cleanup-git`, followed by your request; installation alone starts no cleanup. If inventory is absent or failed, fallback to read-only git/gh commands. Use the supplied `inventory_command` in `inventory_cwd` to refresh it. Inventory collection batches common checks such as `rev-parse`/`symbolic-ref` (repository and target), `for-each-ref` (branches, tips, upstreams), `worktree list --porcelain` (registrations and locks), `status --porcelain`/`ls-files --stage` (local/ignored files and submodules), `show`/`rev-list`/`merge-base --is-ancestor` (dates, divergence, merge evidence), and `config --get-regexp` (deletion protections); additional git/gh commands may be necessary depending on the situation.

## Process

### 1. Scan
- Find any existing project rules regarding git/github cleanup, worktree lifecycle, etc.
- Perform a complete Git and Github scan.
- Identify the **project protected branches** that should not be affected by the cleanup. The hook uses this non-exhaustive list: main, master, develop, development, dev, staging, stage, production, prod, release, releases, stable, current, trunk, integration, int, preprod, pre-production, preproduction.
- Apply every matching rule below (user and project rules that conflict with these take precedence.):

| State | Action |
| --- | --- |
| Current branch tip is an ancestor of the selected target; no protection or worktree applies | Propose branch deletion. |
| Commits remain outside the target | Preserve and explain the remaining work. |
| Squash/rebase merge or cherry-picked changes | Inspect content and PR evidence; preserve unless the user approves the specific rewritten-history case. |
| Merged PR followed by local commits | Preserve the later work. |
| Open PR, including a draft | Preserve. |
| Closed PR or deleted remote branch | Require independent merge evidence. |
| No upstream or PR | Use target ancestry; neither is required. |
| Default, target, main/master, develop/development, release/*, project-protected branch, or branch.deleteMerged=false | Preserve. |
| Another local branch tracks this branch | Preserve and report the dependency. |
| Branch checked out in a worktree | Preserve by default. Propose linked-worktree removal separately only when merged, inactive, and fully inspected. |
| Current, main, bare, detached, or locked worktree | Preserve. |
| Staged, unstaged, untracked, conflicted, or ignored files | Preserve; explain local files before any separately requested discard. |
| Merge, rebase, am, cherry-pick, revert, sequencer, or bisect state | Preserve the affected worktree and branch. |
| Worktree has submodules | Preserve; inspect submodule repositories separately if removal is requested. |
| Missing, inaccessible, moved, or prunable worktree | Investigate registration and storage availability before proposing repair or specific stale-metadata cleanup. |
| Shallow history, failed checks, invalid target, or unknown required PR state | Resolve the missing facts or preserve. |
| Remote integration is required but remote refs were not refreshed | Fetch the selected target and refresh the inventory; preserve if verification is unavailable. |
| Repository, tips, mappings, or file state changes | Reassess the affected action. |

### 2. Report
Present every branch/worktree with its proposed action and reason. Explain remaining work and unresolved facts. Propose worktree removal separately from branch deletion.

### 3. Apply
Obtain approval for the named cleanup actions unless the user already approved them specifically. Double check the live state; refresh affected facts immediately before each action. Proceed with the cleanup approved following the user decisions, user rules and project rules.
