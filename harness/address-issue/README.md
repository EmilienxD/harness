# Address Issue

Implement a GitHub issue on the current checkout and commit the verified result. The skill
replaces the former `implement` worker placeholder and is used both manually and by Aboard's
Auto Run implementer.

## Install

```bash
uvx --from git+https://github.com/EmilienxD/harness@v0.2.0 harness
```

The skill is user-invocable only on both platforms. Restart the selected product after
installation and review/trust its project hooks when prompted. Issue preloading requires `git`
and an authenticated `gh` with access to the referenced repositories.

## Use

```text
/address-issue 42
/address-issue 42, 51
/address-issue https://github.com/owner/repo/issues/42
/address-issue <the complete text of an issue>
```

Use `$address-issue` in ChatGPT, with the reference or issue text in the surrounding user text.

Reference mode applies only when the **entire** trimmed argument is one positive issue number,
comma-separated issue numbers, one full GitHub issue URL, or comma-separated full URLs. Bare
numbers resolve against the current repository; URLs may identify another one. Any other
argument is treated as supplied issue text, so a body containing `#123` stays literal and
triggers no lookup.

## The hook

A synchronous `UserPromptSubmit` hook ignores unrelated prompts and, for an `address-issue`
invocation:

- Requires a completely clean worktree — staged, unstaged, and untracked changes all block
  before model invocation; ignored files do not count.
- Injects confirmation that the worktree was verified clean.
- In reference mode, fetches each requested issue with its number and repository, title, body,
  author, labels, comments, parent, sub-issues, and same-repository references from included
  bodies.
- Injects nothing from GitHub when issue text was supplied.

A missing, closed, inaccessible, or unauthenticated primary issue reference blocks the prompt
with an actionable message. Related contextual issues may be closed and dangling links are
skipped.

## Configuration

`HARNESS_ISSUE_CONTEXT_DEPTH` sets relation traversal depth: `0` loads the requested issues
only, `1` (the default) adds direct parents, sub-issues, and references, and `2` or more
continues through that many levels. Aboard's `aboard.autoRun.issueContextDepth` setting carries
the same meaning for Auto Run.

Protective limits bound the injected context: at most 50 related issues, the newest 20 comments
per issue, and roughly 60,000 characters in total. Anything dropped is disclosed in an
**Omitted context** section.

## Worker protocol

The agent may use read-only Git operations plus `git add` and `git commit`. It must not push,
fetch, pull, merge, rebase, reset, switch branches, manipulate branches, tags, remotes, or
worktrees, or mutate GitHub state. It commits once, only after completing and verifying the
implementation, and it invokes neither subagents nor other skills.

Manual invocation has no automated postcondition validator: review the resulting repository
state yourself. Under Aboard, a run is successful only when the process succeeds, exactly one
descendant commit exists, and the worktree is clean.
