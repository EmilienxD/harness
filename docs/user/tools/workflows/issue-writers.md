# Issue writers

## When to use

Use `draft-issue` for one agent-sized vertical slice, `draft-issues` for a connected set, `to-spec` for a spec in the response, and `to-spec-draft-issue` for an editable spec issue. `publish-issues` is the separate publication step.

## Invocation

Claude Code uses `/skill-name`; ChatGPT uses `$skill-name`; Pi uses `/skill:skill-name`. Pi also accepts the shorter drafting aliases and handles `/publish-issues [--dry]` as a native command with zero inference. `/skill:publish-issues [--dry]` is intercepted too. Pass a request, plan, spec path, issue number, or URL to a drafting skill. Use `publish-issues --dry` to preview before publishing.

## What happens

`draft-issues` proposes titles, parent links, dependencies, and labels, then waits for your approval before writing files. `to-spec` synthesizes existing context without another interview. Drafting skills never create GitHub issues directly: the publication hook or native Pi command creates them and resolves links between drafts.

## Files and prerequisites

Claude Code and ChatGPT are supported through hooks; Pi uses an extension and the same publishing core. `git` and `gh` are required; publication needs repository access. Drafts live in `.harness/issue-drafts/` as editable Markdown. Published drafts are deleted, and abandoned drafts are swept after a week. If `publish-issues` reaches the model, check that its hook is enabled and trusted.

## Example

`/draft-issues docs/spec.md`, approve the mapping, review the draft files, and run `/publish-issues --dry` before publishing.

Pi namespaces native session IDs into separate draft batches, preserves identity across reload/resume, and supplies the next draft path for all four drafting/spec skills. Publication retains repository locks, dependency ordering, parent links, crash recovery and pending notices. A new/forked Pi session has its own batch. Notices reach the next non-publication prompt once. Finish the active turn before invoking these workflows. Reload Pi after installation and approve the extension resources; a missing skill or failed setup stops preparation. Native JSON/RPC project and user journeys were verified on Pi 1.2.0 with both local fake GitHub journeys and real authenticated `gh` against the private `harness-e2e` test repository.
