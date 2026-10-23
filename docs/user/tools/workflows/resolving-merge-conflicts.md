# Resolving merge conflicts

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install resolving-merge-conflicts`; see [installation and scope](../../getting-started.md).

## When to use

Use this skill while a Git merge or rebase is stopped on unresolved conflicts. It is intended to finish the operation, including its commits.

## Invocation

Use `/resolving-merge-conflicts [context]` in Claude Code or `$resolving-merge-conflicts [context]` in ChatGPT. State the merge goal if it is not obvious from history.

## What happens

The agent checks Git state, conflicting files, commits, and relevant issues or pull requests. It resolves each hunk according to both sides' intent, records trade-offs when needed, runs project checks, stages results, and finishes the merge or continues the rebase through all commits. It does not abort the operation.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. An in-progress Git merge or rebase and the repository's validation tools are practical prerequisites. The package installs a skill but no project configuration. Running it changes conflicted files and Git history.

## Example

After `git rebase main` stops, use `/resolving-merge-conflicts Preserve the new authentication flow while rebasing billing`.

## Pi usage

Use `/skill:resolving-merge-conflicts`. The same merge/rebase intent tracing, resolution and project verification apply through native read, edit and shell tools.
