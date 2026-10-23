# Break down a help wanted issue

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install breakdown-help-wanted-issue`; see [installation and scope](../../getting-started.md).

## When to use

Use this skill when a request is unclear and you want to agree on the actual solution before drafting issues or writing code.

## Invocation

Use `/breakdown-help-wanted-issue [request]` in Claude Code or `$breakdown-help-wanted-issue` in ChatGPT. Supply a description, spec path, issue number, or URL. With no argument, it looks up the oldest open GitHub issue labeled `[AI]-help-wanted`.

## What happens

The agent reads the request and relevant references, checks project context, explains the underlying problem and current behavior, and recommends a concrete scope and success criteria. It asks you about unresolved choices and waits until you confirm shared understanding. The output is a short agreed summary; the skill does not implement or publish it.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. `git` and `gh` are required; the default lookup needs access to the repository's issues. The package installs no project output file or configuration.

## Example

`/breakdown-help-wanted-issue #42` explores that issue with you. If the default lookup finds no issue, provide the request directly.

## Pi usage

Use `/skill:breakdown-help-wanted-issue [request]`. The shared clarification workflow is unchanged. Looking up the oldest help-wanted issue requires authenticated `gh`; Pi itself supplies no GitHub authentication.
