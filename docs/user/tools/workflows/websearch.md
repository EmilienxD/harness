# Websearch

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install websearch`. See [installation and scope](../../getting-started.md).

## When to use

Use `websearch` when you need current external documentation or a source-backed answer to a research question. It is a read-only research workflow apart from maintaining its source index.

## Invocation

Use `/websearch [question]` in Claude Code or `$websearch [question]` in ChatGPT. You can name preferred search tools. Otherwise the skill defaults to the Context7 CLI for library documentation, supplemented by available web search and page-fetching tools.

## What happens

Before searching, the agent reads the installed source index. It checks relevant known sources, researches the question, and returns a concise synthesis with citations and uncertainty where needed. It adds only relevant, trusted sources to the index for later sessions, avoiding duplicates and incidental findings.

## Files and prerequisites

Claude Code, ChatGPT, and Pi are supported. The package installs a user-editable starter index at `.harness/websearch/INDEX.md` for project installs or `~/.harness/websearch/INDEX.md` for user installs. All providers share these paths. Research uses the project index when present and otherwise the home index, and saves sources back to the selected index. Fresh research needs network access and a working search tool.

The default Context7 commands run through `npx`. Source code stays unchanged.

## Example

`/websearch What changed in the latest version of our database driver?` asks for a cited answer grounded in current sources.

## Pi usage

Use `/skill:websearch <question>`. The shared research skill uses Context7 for library documentation and available search/fetch tools. Missing web access is a reported coverage gap. Native discovery, invocation, index reads and removal are covered by the shared-skill journeys.
