# Set up a Git worktree maker

## When to use

Use this skill to create a repeatable repository-specific worktree setup command. The skill writes that command; it does not itself create a worktree.

## Invocation

Use `/setup-git-worktree-maker [setup requirements]` in Claude Code or `$setup-git-worktree-maker` in ChatGPT from inside a Git working tree. Arguments describe setup needs, not a branch to create.

## What happens

The agent surveys manifests, lockfiles, setup docs, ignored local files, existing helpers, and all `.env` paths. It identifies secret-bearing files by path without reading them. It proposes the script, copy list, initialization order, alias, and optional VS Code task, then waits for approval before writing. The resulting command accepts or prompts for a branch, creates a numbered sibling worktree, copies approved files, runs setup, and cleans up state it created if setup fails.

## Files and prerequisites

Both providers are supported. Git and a working checkout are required. The output script, alias, copied paths, and optional `Create Git Worktree` VS Code task depend on the approved plan; no fixed output path is installed.

## Example

`/setup-git-worktree-maker Copy local app configuration and initialize both Python and JavaScript workspaces` produces a plan for review before implementation.
