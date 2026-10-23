# Issue readers

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install issue-readers`; see [installation and scope](../../getting-started.md).

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

## Pi routing and context preparation

`issue-readers` 1.6.1 and `issue-writers` 2.3.1 depend on `pi-issue-workflows` 1.0.0
and its `pi-transport` dependency for routing and bounded, cancellable Python calls.
Native input interception runs before `/skill:` expansion;
short slash aliases expand through the selected native skill too. The extension checks that
the skill is available, preserves images, and stops workflow preparation during another active
turn. Context travels with the actual input rather than mutable pending state. Session replacement,
tree navigation and shutdown cancel transport and suppress stale delivery. Issue helpers have a
two-minute deadline and the bridge's 2 MiB input/output bounds; oversize context fails instead of
silently truncating requirements. Interpreter cancellation terminates the subprocess tree.

Readers reuse checkout admission and local review scope from the existing hook, and all-page
GraphQL retrieval from `issue_graph.py`. Primary issues must be open for addressing. Relation depth
is still `HARNESS_ISSUE_CONTEXT_DEPTH`; parent, sub-issue, blocker, blocking and body references
are deduplicated, and every included issue retains its full paginated context.

## Verification

`npm run test:pi-issues` installs actual catalogue payloads at project and user scopes on Pi 1.2.0.
Real JSON/RPC tools implement and review a fixture, stop dirty addressing before inference, write
the supplied session draft path, and publish through a local fake GitHub CLI. Checks include dry-run,
invalid options, reload, session isolation, all five native skill routes, exact request counts,
starter ownership and last-dependent bridge removal. This certifies native integration and shared
core reuse, not unscripted model judgment.

`npm run e2e:pi-issues:live` additionally verifies real `gh` against the private
`EmilienxD/harness-e2e` repository at project and user scope, with real Pi 1.2.0 JSON/RPC
and fake inference. A parent/child draft batch is published with labels, rewritten references
and a real parent link. Both readers receive the live issue graph and a maintainer comment.
Dry-run leaves GitHub untouched and publication uses zero inference. Only the run's UUID-tagged
issues and newly added gateway labels are cleaned; existing repository state is preserved.
