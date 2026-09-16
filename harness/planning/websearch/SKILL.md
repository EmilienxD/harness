---
name: websearch
description: Research a question and return a concise, source-backed answer. Use when the user explicitly requests web research.
argument-hint: "[research question]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Research the user's query and answer it directly in chat. Except for the source index described below, this is a strictly read-only workflow: do not create, edit, or write files anywhere.

Prefer any tool the user requests. Otherwise search in this order, moving to the next source only when the earlier one is unavailable or insufficient:

1. Additional user-configured MCP servers or CLIs relevant to the query.
2. Context7 for library and framework documentation.
3. Built-in web tools.

You may quickly search the codebase when its dependencies, versions, terminology, or implementation details would make the research more accurate.

For current library documentation, use Context7 before built-in web tools. `library` resolves a human-readable package name and can use the optional topic to rank matches; its output includes the library ID needed by `docs`. `docs` requires that ID and one focused documentation question. Run separate `docs` queries for distinct topics unless the question is about how they interact.

```bash
npx ctx7@latest library <name> [topic]
npx ctx7@latest docs <library-id> "<specific topic>"
```

Skip `library` when the Context7 library ID (for example, `/facebook/react`) is already known. Add `--json` when structured output is useful.

The shared source index is at `<scope-root>/.harness/websearch/INDEX.md`, where `<scope-root>` is the project root for a project installation or the home directory for a user installation. Before doing any search, read that index to get a list of common, known, and validated sources. Use any source that is relevant to the task and fetch it. After every web search, add ONLY the relevant and trusted sources found during the search to the index. Use this format:

```markdown
- Concise title: Source (e.g. URL, Context7 library id).
```

Avoid incidental findings, duplicates, and low-quality sources. Maintain the index in its correct format.

Return a complete synthesis that answers the request, cites the supporting sources, distinguishes uncertainty when necessary, and filters out non-essential research findings rather than recounting the search process.
