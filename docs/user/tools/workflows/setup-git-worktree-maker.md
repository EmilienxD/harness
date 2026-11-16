# Set up a Git worktree maker

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install setup-git-worktree-maker`. See [installation and scope](../../getting-started.md).

## When to use

Use this skill to create a repeatable repository-specific worktree setup command. The skill writes that command. It does not itself create a worktree.

## Invocation

Use `/setup-git-worktree-maker [setup requirements]` in Claude Code or `$setup-git-worktree-maker` in ChatGPT from inside a Git working tree. Arguments describe setup needs, not a branch to create.

## What happens

The agent surveys manifests, lockfiles, setup docs, ignored local files, existing helpers, and all `.env` paths. It identifies secret-bearing files by path without reading them. It proposes the script, copy list, initialization order, alias, and optional VS Code task, then waits for approval before writing.

The resulting command accepts or prompts for a branch, creates a numbered sibling worktree, copies approved files, runs setup, and cleans up state it created if setup fails.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. Git and a working checkout are required. The output script, alias, copied paths, and optional `Create Git Worktree` VS Code task depend on the approved plan. No fixed output path is installed.

## Example

`/setup-git-worktree-maker Copy local app configuration and initialize both Python and JavaScript workspaces` produces a plan for review before implementation.

## Pi usage

Use `/skill:setup-git-worktree-maker`. Include ignored project Pi resources only when the new checkout needs them. Keep personal authentication and native session state out of copied assets. Validation does not create a worktree.
