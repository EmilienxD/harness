# Issue readers

## When to use

Choose `address-this` to implement a request end to end, or `review-this` to inspect a pinned change before it lands. The review target can be a commit, branch, tag, merge base, range, pull request, or whole diff. With no target, the review uses `HEAD` against its parent.

## Invocation

Claude Code: `/address-this <request>` or `/review-this <target>`. ChatGPT: `$address-this` or `$review-this` with the same context. Pi: `/skill:address-this <request>` or `/skill:review-this <target>`; the shorter `/address-this` and `/review-this` aliases also work.

## What happens

The installed hook or Pi extension prepares issue and local checkout context. Addressing checks acceptance criteria and runs relevant validation. Reviewing reads the whole pinned diff, fixes clear local material problems, validates repairs, and reports blockers that require decisions or broader work.

## Files and prerequisites

The package requires `git` and `gh`. Its two skill bodies are user-editable starter files. Claude Code, ChatGPT, and Pi are supported; callers such as Aboard can add a completion contract.

## Example

`/skill:review-this 123` in Pi prepares issue #123 as requirements for the local review target. Supply an exact commit or range when the intended scope is narrower.

Pi prepares context before native skill expansion. Strict comma-separated issue numbers or GitHub issue URLs fetch complete paginated bodies, comments, labels, dependency relationships and mentioning PRs. Related issues follow `HARNESS_ISSUE_CONTEXT_DEPTH` (default 1). Literal request text stays literal. Addressing requires a clean worktree and open primary issues; reviewing accepts the existing worktree as its target, or the last commit when clean. GitHub failures, output beyond 2 MiB, and preparation beyond two minutes stop the invocation before inference. These checks cover native JSON/RPC on Pi 1.2.0.
