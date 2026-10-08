# Issue readers

## When to use

Choose `address-this` to implement a request end to end, or `review-this` to inspect a pinned change before it lands. The review target can be a commit, branch, tag, merge base, range, pull request, or whole diff. With no target, the review uses `HEAD` against its parent.

## Invocation

Claude Code: `/address-this <request>` or `/review-this <target>`. ChatGPT: `$address-this` or `$review-this` with the same context.

## What happens

The installed hook prepares bounded issue or commit context. Addressing checks acceptance criteria and runs relevant validation. Reviewing reads the whole pinned diff, fixes clear local material problems, validates repairs, and reports blockers that require decisions or broader work.

## Files and prerequisites

The package requires `git` and `gh`. Its two skill bodies are user-editable starter files. Both providers are supported; callers such as Aboard can add a completion contract.

## Example

`/review-this #123` reviews the supplied target. Supply an exact commit or range when the intended scope is narrower.
