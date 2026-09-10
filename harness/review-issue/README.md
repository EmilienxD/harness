# Issue Review

Review the commit at `HEAD` on the current checkout, fix straightforward findings, and commit
those fixes. One skill replaces the former `review-afk` and `review-hitl` placeholders: AFK and
HITL remain Aboard orchestration modes, not separate reviewers.

## Install

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

The skill is user-invocable only on both platforms. Restart the selected product after
installation and review/trust its project hooks when prompted. It requires `git`.

## Use

```text
/review-issue
/review-issue focus on the error paths
```

Use `$review-issue` in ChatGPT, with any focus in the surrounding user text.

## The hook

A synchronous `UserPromptSubmit` hook ignores unrelated prompts and, for an `review-issue`
invocation:

- Requires a completely clean worktree — staged, unstaged, and untracked changes all block
  before model invocation; ignored files do not count.
- Injects the starting `HEAD` SHA, its parent SHA when one exists, and the commit subject.
- Injects the name and status of every file the commit changed, including additions,
  deletions, and renames.
- Does not inject the diff; the agent reads it itself.

## Worker protocol

The agent may use read-only Git operations plus `git add` and `git commit`. It must not push,
fetch, pull, merge, rebase, reset, switch branches, manipulate branches, tags, remotes, or
worktrees, or mutate GitHub state. It fixes straightforward findings immediately and commits
them only when no unresolved blocker remains; a review with no findings succeeds without
creating an empty commit. It invokes neither subagents nor other skills.

Manual invocation has no automated postcondition validator: review the resulting repository
state yourself. Under Aboard, a run is successful when the process succeeds, the worktree is
clean, and `HEAD` is either unchanged or exactly one descendant commit ahead. Aboard pauses
after a successful HITL review and continues after a successful AFK one.
