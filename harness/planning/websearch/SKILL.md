---
name: websearch
description: Research a question on the web and return a concise, complete, source-backed answer. Explicit invocation only.
disable-model-invocation: true
---

Research the user's query and answer it directly in chat. Except for the source index described below, this is a strictly read-only workflow: do not create, edit, or write files anywhere.

Use any resources available for web research, including built-in web tools, the Context7 documentation library through `npx ctx7@latest`, or any other available tools such as MCP servers or CLIs. Prefer the tools the user asks for if any. You may quickly search the codebase when its dependencies, versions, terminology, or implementation details would make the research more accurate.

For current library documentation, resolve the library first, then query its documentation:

```text
npx ctx7@latest library <name> "<specific topic>"
npx ctx7@latest docs <library-id> "<specific topic>"
```

Skip the first command when the user already supplied a Context7 ID such as `/org/project` or `/org/project/version`. Use focused queries and only the read-only `library` and `docs` commands.

## Source index

The skill directory contains an initially empty Markdown index at `<skill-directory>/sources.md`. Before researching, read it for relevant leads. After every web or Context7 search, add the newly found sources that materially helped the research directly to that file, using any clear Markdown format (for example, `- [Concise title](canonical URL)` or a Context7 identifier).

Record only sources likely to help later agents quickly find useful, authoritative information. Prefer official primary sources; omit search-result pages, incidental findings, duplicates, and low-quality sources. If a search produced no useful source, add nothing. Updating `sources.md` is the only permitted file write; never create or modify any other file during this workflow.

Return a complete synthesis that answers the request, cites the supporting sources, distinguishes uncertainty when necessary, and filters out non-essential research findings rather than recounting the search process.
