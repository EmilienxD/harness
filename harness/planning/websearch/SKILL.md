---
name: websearch
description: Research a question on the web and return a concise, complete, source-backed answer. Explicit invocation only.
disable-model-invocation: true
---

Research the user's query and answer it directly in chat. Except for the source index described below, this is a strictly read-only workflow: do not create, edit, or write files anywhere.

Use any resources available for web research, including built-in web tools, the Context7 documentation library through `npx ctx7@latest`, or other available tools such as MCP servers or CLIs. Prefer any tools the user requests. You may quickly search the codebase when its dependencies, versions, terminology, or implementation details would make the research more accurate.

For current library documentation, resolve the library first, then query its documentation:

```bash
npx ctx7@latest library <name> "<specific topic>"    # Skip when the library id is already known
npx ctx7@latest docs <library-id> "<specific topic>"
```

Before doing any search, read INDEX.md to get a list of common, known, and validated sources. Use any source that is relevant to the task and fetch it. After every web search, add ONLY the relevant and trusted sources found during the search to the index. Use this format:

```markdown
- Concise title: Source (e.g. URL, Context7 library id).
```

Avoid incidental findings, duplicates, and low-quality sources. Maintain the index in its correct format.

Return a complete synthesis that answers the request, cites the supporting sources, distinguishes uncertainty when necessary, and filters out non-essential research findings rather than recounting the search process.