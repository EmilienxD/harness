# Cleanup git

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install cleanup-git`. See [installation and scope](../../getting-started.md).

Automatically inventories every local branch and worktree with a bundled read-only script that runs without arguments from the current directory. Supplies a titled **Git cleanup inventory** in compact TOON tables. Checks merge ancestry, protected branches, local and ignored files, locks, submodules, and ongoing Git operations. Includes GitHub facts when `gh` is available.

The skill contains the cleanup rules and proposes named actions for approval before deletion or worktree removal. On Pi, `/cleanup-git` and `/skill:cleanup-git` prepare the inventory before expanding the native skill.
