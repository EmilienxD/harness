---
name: websearch
description: Developer-invoked only. Agents must not invoke this skill on their own. Research a question and return a concise, source-backed answer. Use when the developer explicitly requests web research.
argument-hint: "[research question]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

Research the developer's query and answer it directly in the end turn message. This is a read-only workflow: do not create or edit source code.

You may quickly search the codebase when its dependencies, versions, terminology, or implementation details would make the research more accurate.

Before doing any search, read `.harness/websearch/INDEX.md` to get a list of common, known, and validated sources for the project. Without a project index, use `~/.harness/websearch/INDEX.md`. Keep using the selected index for this research. Use any source that is relevant to the task and fetch it.

If the developer requests you to use specific search tools, use them. Otherwise, default to the Context7 npx CLI and complete the search with your available web search tools. If web tools are unavailable, report the coverage gap and synthesize only from sources you could access.

How to use the Context7 CLI:
- Resolve a library name to a Context7 library ID: `npx ctx7@latest library <name> [topic]` where `name` is the library name to search for and `topic` is what to look up in the library's documentation.
- Query documentation for a library: `npx ctx7@latest docs <library-id> <query>` where library-id is the Context7 library ID (e.g., /facebook/react) and `query` is a single-topic question to get docs for (run a separate query per distinct concept, unless asking how they interact)

Trace your sources in the selected index for the next sessions to pick up. ONLY save the relevant and trusted sources found during the search. Use 1 concise bullet point per source with the format `- title: source` where title is a title you define and source is the info needed to fetch (e.g. a Context7 id, or url)

Avoid incidental findings, duplicates, and low-quality sources.

Return a complete synthesis in your end turn message (do not create a file) that answers the request, cites the supporting sources, distinguishes uncertainty when necessary, and filters out non-essential research findings rather than recounting the search process.
