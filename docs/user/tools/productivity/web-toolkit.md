# Web toolkit

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install web-toolkit`. See [Get started](../../getting-started.md) for provider and scope options.

## When to use it

Search for current information and read source pages without leaving your agent. Fetch readable web pages, PDFs, and text documents.

## Use it

Invoke `/web-toolkit` in Claude Code, `$web-toolkit` in ChatGPT, or `/skill:web-toolkit` in Pi. Ask a research question or provide the page you want read. Pi users can install `web-toolkit-native` for direct `web_search` and `web_fetch` tools instead of the skill, or alongside it.

```bash
harness install web-toolkit-native --platform pi
```

Command-line search: `web-toolkit search "your question"`. Command-line reading: `web-toolkit fetch <url>`. Search returns titles, links, and excerpts. Read the linked sources before relying on them. Long documents are saved locally so the agent can read the remaining content. Pi search accepts `allowed_domains` and `blocked_domains`. Exclusions take priority and include subdomains.

## Requirements and limits

Install uv, Git, and Google Chrome or Microsoft Edge. The first use can take longer while dependencies download. The browser uses a separate profile and does not share your usual website logins. Use an authenticated service tool for private pages. Search engines can throttle automated requests.
