---
name: setup-git-worktree-maker
description: Create or update a repository-specific, agent-free command that creates and fully initializes Git worktrees. Use when setting up reusable worktree automation for a project; optional arguments describe copied files, setup commands, or script preferences, not a branch to create now.
disable-model-invocation: true
---

# Set Up a Git Worktree Maker

Build the repository a reusable command for creating initialized worktrees. Do not create a worktree while performing this setup.

## Inspect

First verify that the current directory is inside a Git working tree. If it is not, stop with a clear explanation.

Inspect only enough of the repository to identify:

- script directories, filenames, command aliases, and languages already used;
- manifests, lockfiles, package managers, workspace or monorepo configuration;
- setup documentation and existing bootstrap commands;
- environment examples, ignored project-local configuration, and files the user explicitly requested to copy;
- existing worktree helpers; and
- `.vscode/tasks.json` and nearby VS Code conventions.

Treat invocation arguments as setup requirements and preferences. They never name the first worktree branch. Combine them with repository evidence to choose the script language, path, filename, native runner or command alias, and a deterministic setup sequence. Do not add a new runtime or dependency merely to implement the command.

Ask only about a material choice that evidence and arguments do not settle. If the script location is still uncertain, ask where to write it. Do not invent a dependency command from a manifest alone when multiple lockfiles, workspace roots, or documented setup paths make the correct command ambiguous.

Before generating code, read [references/generated-command-contract.md](references/generated-command-contract.md) and implement every applicable requirement.

## Generate

Create one self-contained project-native script and, when the repository has an established command runner, expose it through that runner. The runtime command must not require an agent. Keep its configuration fixed in the generated files; its only interactive question is the branch prompt when the branch argument is absent.

Order setup steps according to their dependencies. Copy only files explicitly requested or confidently identified as ignored, project-local configuration for this checkout. Preserve paths relative to the invoking checkout. Never copy arbitrary external secrets or infer unsupported initialization commands.

Add a short, language-appropriate marker identifying files or blocks managed by `setup-git-worktree-maker`. Inspect every existing target before editing it:

- Update a recognizable managed script, alias, or task in place.
- Preserve unrelated scripts, command definitions, tasks, settings, formatting, and JSONC comments where practical.
- If the chosen name or location contains user-owned content, ask before replacing or materially rewriting it.
- Do not create duplicate command aliases or VS Code tasks on reruns.

Validate the generated script with the strongest safe check that does not create a worktree, such as parsing, linting, compilation, or its non-mutating help path. Also inspect the final diffs for accidental unrelated changes. Do not commit the files.

## VS Code

If `.vscode/` already exists, add or update one task labeled `Create Git Worktree` that invokes the project-native command in an integrated terminal and allows its interactive branch prompt. If `.vscode/` does not exist, ask before creating it; declining affects only the task, not script generation.

Identify the managed task with a stable marker field when the task schema permits it. Preserve every unrelated task and setting, and reuse the existing task on reruns.

## Report

Explain the files and command alias created or updated, the fixed copy/install/initialization sequence, and both invocation forms: with a branch argument and with interactive prompting. State whether VS Code integration was added. Explicitly confirm that setup did not create a worktree.
