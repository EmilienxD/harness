# Generated Command Contract

Use this checklist when designing and validating the generated command. Adapt syntax to the repository's chosen language, but do not weaken these behaviors.

## Invocation and repository identity

- Accept zero or one branch-name argument. With zero arguments, prompt interactively. Reject additional arguments unless the project's runner consumes a documented separator.
- Trim and reject an empty response with a clear error. Validate the value as a local branch name with Git before changing anything, and pass user-controlled values as quoted arguments rather than interpolated shell source.
- Work from any directory inside any checkout or registered linked worktree. Resolve the invoking checkout's top level and current `HEAD` before changing directories.
- Resolve the primary checkout or stable repository anchor from Git metadata (for example, the absolute common Git directory or registered worktree data). Derive the base directory name and sibling parent from that stable anchor, never from the invoking linked worktree's possibly suffixed name.

## Destination selection

- Inspect sibling entries named exactly `<base>-<nonnegative integer>` and choose one greater than the highest suffix. Start at `<base>-0` when none exist. Never fill an earlier gap.
- Use an absolute destination path and refuse to proceed if any file-system entry already occupies it.
- Registered worktree paths may be consulted to detect inconsistent layouts, but do not silently choose a different naming root. If Git metadata cannot identify a safe stable sibling location, fail before mutation.

Thus sibling entries `project`, `project-0`, and `project-2` yield `project-3`.

## Branch handling and worktree creation

Capture whether `refs/heads/<branch>` existed before the run. Inspect `git worktree list --porcelain` (or an equivalently unambiguous Git interface) before mutation.

- If the local branch is already attached to a worktree, fail and identify that worktree path.
- If the local branch exists and is unattached, run the equivalent of `git worktree add <path> <branch>`.
- If it does not exist, create it from the invoking checkout's captured `HEAD` with the equivalent of `git worktree add -b <branch> <path> <captured-head>`.

Do not substitute remote-branch guessing for these rules. Mark the worktree as created only after Git reports success, while still tracking a newly created branch if a partially failed Git operation leaves it behind.

## Fixed project setup

After Git creates the worktree, run the generated setup plan in a deterministic order. Typical ordering is:

1. Create required destination directories and copy the approved project-local files from the invoking checkout.
2. Install or synchronize dependencies from the correct workspace root or roots.
3. Run explicitly requested or confidently documented initialization commands.

Show concise progress that names each step. Run every command with the new worktree (or its intended workspace subdirectory) as its working directory. Stop on the first failure without hiding the command's useful stdout, stderr, or exit status. Do not ask runtime configuration questions.

On success, print an unambiguous success message and the new worktree's absolute path.

## Transaction and rollback

Install failure handling before the first mutating operation. If anything fails after worktree creation, or a `git worktree add -b` attempt leaves a branch or partial registration behind:

1. Report the failed step and retain its useful error output.
2. Attempt `git worktree remove --force <path>` from a valid checkout. If needed, remove only the exact precomputed destination after rechecking that it is the intended generated sibling; never recursively delete a broad, unresolved, root, home, or repository path.
3. Run `git worktree prune` when stale metadata may remain.
4. Delete the requested branch only when it was absent before this run and this run created it. Never delete a pre-existing branch. Do not delete a newly created branch until the partial worktree is detached or removed.
5. Report each cleanup failure separately. Name any path, registration, or newly created branch still requiring manual cleanup.
6. Exit nonzero even when cleanup succeeds.

Cleanup should be safe to retry. A failure before any mutation needs no rollback.

## Idempotent integration

- Preserve a stable generated marker in the script and managed command definitions.
- Make the project command accept the optional branch argument without breaking interactive use. Document any runner separator, such as `--`, in the final instructions.
- A VS Code task must invoke the same project command in an integrated terminal without supplying a branch, so the prompt remains usable. Update the marked task rather than appending another one.
