# Websearch

## When to use

Use `websearch` when you need current external documentation or a source-backed answer to a research question. It is a read-only research workflow apart from maintaining its source index.

## Invocation

Use `/websearch [question]` in Claude Code or `$websearch [question]` in ChatGPT. You can name preferred search tools; otherwise the skill defaults to the Context7 CLI for library documentation and basic web search as needed.

## What happens

Before searching, the agent reads the installed source index. It checks relevant known sources, researches the question, and returns a concise synthesis with citations and uncertainty where needed. It adds only relevant, trusted sources to the index for later sessions, avoiding duplicates and incidental findings.

## Files and prerequisites

Both providers are supported. The package installs a user-editable starter index at `.harness/websearch/INDEX.md`. Fresh research needs network access and a working search tool; the default Context7 commands run through `npx`. Source code stays unchanged.

## Example

`/websearch What changed in the latest version of our database driver?` asks for a cited answer grounded in current sources.
