# Issue writers

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install issue-writers`; see [installation and scope](../../getting-started.md).

## When to use

Use `draft-issue` for one agent-sized vertical slice, `draft-issues` for a connected set, `to-spec` for a spec in the response, and `to-spec-draft-issue` for an editable spec issue. `publish-issues` is the separate publication step.

## Invocation

Claude Code uses `/skill-name`; ChatGPT uses `$skill-name`; Pi uses `/skill:skill-name`. Pi also accepts the shorter drafting aliases and handles `/publish-issues [--dry]` as a native command with zero inference. `/skill:publish-issues [--dry]` is intercepted too. Pass a request, plan, spec path, issue number, or URL to a drafting skill. Use `publish-issues --dry` to preview before publishing.

## What happens

`draft-issues` proposes titles, parent links, dependencies, and labels, then waits for your approval before writing files. `to-spec` synthesizes existing context without another interview. Drafting skills never create GitHub issues directly: the publication hook or native Pi command creates them and resolves links between drafts.

## Files and prerequisites

Claude Code and ChatGPT are supported through hooks; Pi uses an extension and the same publishing core. `git` and `gh` are required; publication needs repository access. Drafts live in `.harness/issue-drafts/` as editable Markdown. Published drafts are deleted, and abandoned drafts are swept after a week. If `publish-issues` reaches the model, check that its hook.

## Example

`/draft-issues docs/spec.md`, approve the mapping, review the draft files, and run `/publish-issues --dry` before publishing.

Pi namespaces native session IDs into separate draft batches, preserves identity across reload/resume, and supplies the next draft path for all four drafting/spec skills. Publication retains repository locks, dependency ordering, parent links, crash recovery and pending notices. A new/forked Pi session has its own batch. Notices reach the next non-publication prompt once. Finish the active turn before invoking these workflows. Reload Pi after installation and approve the extension resources; a missing skill or failed setup stops preparation. Native JSON/RPC project and user journeys were verified on Pi 1.2.0 with both local fake GitHub journeys and real authenticated `gh` against the private `harness-e2e` test repository.

## Pi publication and session ownership

Writers reuse `issues_core.py` without changing publishing semantics. UUIDv5 identities use
`harness:issues:pi:<native-session-id>`; reload/resume retain that batch, while native new/fork
sessions select another. `/publish-issues [--dry]` and `/skill:publish-issues [--dry]` are consumed
without inference. Repository locks, draft ordering, parent links, crash recovery, stale sweeping
and next-prompt notices remain owned by the shared core.

Input routing, cancellation, transport limits and the shared acceptance journeys are documented with [issue readers](issue-readers.md#pi-routing-and-context-preparation).
