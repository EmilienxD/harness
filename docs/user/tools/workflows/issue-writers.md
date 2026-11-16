# Issue writers

Platforms: **Claude Code, ChatGPT, Pi**.

Turn an agreed request into reviewable GitHub issue drafts, then publish when you are ready. Install with `harness install issue-writers`. See [Get started](../../getting-started.md) for provider options.

## Choose a workflow

- Use `draft-issue` for one focused piece of work.
- Use `draft-issues` for a connected set of issues with parents and dependencies.
- Use `to-spec` for a specification in the conversation.
- Use `to-spec-draft-issue` for an editable specification issue.
- Use `publish-issues` only when the drafts are ready for GitHub.

## Draft and review

Claude Code uses `/draft-issue` or another workflow name from the list above. ChatGPT uses `$draft-issue` and the equivalent names. Pi uses `/skill:draft-issue` and the equivalent names for drafting and specifications. Supply a request, plan, issue number, or issue URL. For several issues, review the proposed breakdown before approving draft creation. Read the resulting drafts and edit them before publication.

Approving a breakdown or draft does not authorize publication.

## Preview and publish

Claude Code: `/publish-issues --dry`. ChatGPT: `$publish-issues --dry`. Pi: `/publish-issues --dry`. The preview lists drafts, labels, parents, dependencies, and any errors. It does not contact GitHub to verify permissions. Remove `--dry` when you are ready to publish. You can also explicitly ask the agent to publish the reviewed drafts. Publication creates missing labels and preserves existing label styles.

Check the returned issue links and any reported failures.

If publication times out, some issues may already exist. Rerun for recovery instead of creating a second draft batch.

## Requirements and limits

Install Git and the GitHub CLI, then sign in with access to the target repository. Finish the active turn before invoking an issue workflow. Drafts belong to the current session. Resume it to continue the same batch. A new or forked session has its own batch. Published drafts are removed. Abandoned drafts are cleaned up after a week. Pi uses `/publish-issues`, not `/skill:publish-issues`.
