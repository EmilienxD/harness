---
name: setup-git-worktree-maker
description: User-invoked only. Agents must not invoke this skill on their own. Create or update a repository-specific command for fully initialized Git worktrees.
argument-hint: "[copy or setup requirements]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Create a reusable worktree setup command in two phases: explore and obtain approval, then implement. This skill generates the command; it does not create a worktree.

## 1. Explore

Verify that the current directory is inside a Git working tree. Treat invocation arguments as setup requirements, not a branch to create.

Explore the entire repository, including nested applications, packages, and workspaces:

- Find manifests, lockfiles, workspace configuration, setup documentation, existing bootstrap commands, script conventions, and worktree helpers.
- Recursively inventory **all `.env` and `.env.*` paths**, including hidden and ignored files in subdirectories. Use filename-only discovery with exclusions for dependency, build, cache, and virtual-environment directories. Cover every source package, including ignored source directories.
- Inspect ignore rules and list ignored paths (e.g., `git ls-files --others --ignored -exclude-standard`). Look for other checkout-local configuration commonly needed for setup: `.npmrc`, `.pypirc`, `.netrc`, local settings files, development certificates, and configuration paths named in setup documentation. These are copy candidates, not automatic inclusions. Exclude dependency directories, caches, and build outputs.
- Discover secret-bearing files by **path only**. Do not read, print, or source `.env` files or other credential-bearing configuration.
- Inventory project Pi resources under `.pi/` and shared skills under `.agents/skills/`. Tracked resources already arrive through Git; propose exact paths for any required untracked project skills, extensions, prompts, or non-secret configuration. Keep personal Pi authentication, credentials, sessions, and user agent-directory state outside the worktree, including a custom `PI_CODING_AGENT_DIR`. Copying resources does not grant project trust; leave trust decisions to the user.
- Determine dependency and initialization commands for every component, with its working directory and required order. Examples: Python `uv sync`; JavaScript or TypeScript `npm ci` with a suitable lockfile or `npm install` where appropriate; Rust `cargo fetch` or a documented `cargo build`. These are examples, not defaults: follow the repository's actual tooling and setup instructions. Account for workspace-wide commands so packages are neither missed nor initialized twice.

## 2. Propose the plan

Present a concrete plan, without generated code, containing:

- Script location, language (default to Bash), command alias, and any existing content to replace.
- Exact source-relative paths to copy, preserving their layout, and unresolved copy candidates requiring a decision.
- Dependency and initialization commands in execution order, each with its working directory, covering all components or explaining why a component needs no setup.
- Worktree behavior: the future command accepts or prompts for a branch, reuses an unattached local branch or creates one from the invoking checkout's HEAD, and creates a numbered sibling of the primary checkout. Give a naming example; no worktree is created during this skill.
- Proposed VS Code integration, including whether it requires creating `.vscode/`.

Ask the user to approve or suggest modifications, then **stop before writing the script or changing integration files**. Resolve uncertainty in the plan rather than silently inventing commands or selecting sensitive files. After modifications, obtain approval of the revised plan.

## 3. Implement the approved plan

Create one self-contained project-native script and expose it through the approved command runner.

Implement these runtime behaviors:
- Accept zero or one branch argument. Prompt when omitted; reject empty, invalid, or additional arguments. Validate with Git and pass values safely as command arguments.
- Work from any directory inside a checkout or linked worktree. Capture the invoking checkout's root and HEAD before changing directories. Resolve the primary checkout or a stable repository anchor from Git metadata; fail before mutation if a safe sibling location cannot be resolved.
- Choose an absolute sibling path `<repository>-N`, where N is one greater than the highest existing nonnegative numeric suffix, starting at 0. For example, `project`, `project-0`, and `project-2` yield `project-3`. Refuse an occupied destination.
- Inspect registered worktrees and local branches before mutation. Reject a branch already checked out elsewhere, identifying its path. Use an existing unattached local branch; otherwise create it from the captured HEAD, without remote-branch guessing.
- Copy approved files from the invoking checkout, preserving relative paths, then run the approved setup commands in dependency order inside the new worktree or specified workspace directories. Show progress, preserve useful command output, and stop on the first failure.
- Install failure handling before mutation. On failure, clean up worktree state created by this run, including partial creation. Restrict filesystem removal to the verified destination; prune stale registration when needed. Delete a branch only if this run created it and its worktree has been detached or removed. Report cleanup failures and remaining artifacts; exit nonzero.
- On success, print the new worktree's absolute path.

Mark managed scripts and integration entries with `setup-git-worktree-maker`. Update them on reruns, preserving unrelated content and avoiding duplicate aliases or tasks. Stay within the approved plan; seek revised approval for material changes or newly discovered user-owned content that would need replacement.

If approved, add or update a `Create Git Worktree` VS Code task that invokes the same command in an integrated terminal without a branch argument, allowing its prompt.

Concisely tell the user what you created and how to use it.
