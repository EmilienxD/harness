# Issue readers

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install issue-readers`. See [installation and scope](../../getting-started.md).

## When to use

Choose `address-this` to implement a request end to end, or `review-this` to inspect a selected change before it lands. The review target can be a commit, branch, tag, merge base, range, pull request, or whole diff. With no target, the review uses `HEAD` against its parent.

## Invocation

Claude Code: `/address-this <request>` or `/review-this <target>`. ChatGPT: `$address-this` or `$review-this` with the same context. Pi: `/skill:address-this <request>` or `/skill:review-this <target>`. The shorter `/address-this` and `/review-this` aliases also work.

## What happens

The installed hook or Pi extension prepares issue and local checkout context. Addressing checks acceptance criteria and runs relevant validation. Reviewing reads the whole selected diff, fixes clear local material problems, validates repairs, and reports blockers that require decisions or broader work.

Across all three providers, body relation traversal follows standalone `#123` mentions as issues in the containing issue's repository. Markdown links (inline or reference-style) and URLs stay in the supplied body without being traversed.

For example, `[security fix #3186](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/3186)` never triggers a lookup of local issue #3186.

Related references that GitHub reports as missing issues are skipped, and traversal continues with the remaining references. Explicitly requested primary issues still block when missing. Authentication, repository access, network, and other GitHub errors also block preparation.

## Files and prerequisites

The package requires `git` and `gh`. Its two skill bodies are user-editable starter files on Claude Code and ChatGPT. On Pi, they are managed resources installed only inside the native npm package. Claude Code, ChatGPT, and Pi are supported. Callers such as Aboard can add a completion contract.

## Example

`/skill:review-this 123` in Pi prepares issue #123 as requirements for the local review target. Supply an exact commit or range when the intended scope is narrower.

Pi prepares context before native skill expansion. Strict comma-separated issue numbers or GitHub issue URLs fetch complete paginated bodies, comments, labels, dependency relationships and mentioning PRs. Related issues follow `HARNESS_ISSUE_CONTEXT_DEPTH` (default 1). Literal request text stays literal. Addressing requires a clean worktree and open primary issues.

Reviewing accepts the existing worktree as its target, or the last commit when clean. GitHub failures, output beyond 2 MiB, and preparation beyond two minutes stop the invocation before inference. These checks cover native JSON/RPC on Pi 1.2.0.
