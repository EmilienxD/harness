# Issue writers

## When to use

Use `draft-issue` for one agent-sized vertical slice, `draft-issues` for a connected set, `to-spec` for a spec in the response, and `to-spec-draft-issue` for an editable spec issue. `publish-issues` is the separate publication step.

## Invocation

Claude Code uses `/skill-name`; ChatGPT uses `$skill-name`. Pass a request, plan, spec path, issue number, or URL to a drafting skill. Use `publish-issues --dry` to preview before publishing.

## What happens

`draft-issues` proposes titles, parent links, dependencies, and labels, then waits for your approval before writing files. `to-spec` synthesizes existing context without another interview. Drafting skills never create GitHub issues directly: the publication hook creates them and resolves links between drafts.

## Files and prerequisites

Both providers are supported through hooks. `git` and `gh` are required; publication needs repository access. Drafts live in `.harness/issue-drafts/` as editable Markdown. Published drafts are deleted, and abandoned drafts are swept after a week. If `publish-issues` reaches the model, check that its hook is enabled and trusted.

## Example

`/draft-issues docs/spec.md`, approve the mapping, review the draft files, and run `/publish-issues --dry` before publishing.
