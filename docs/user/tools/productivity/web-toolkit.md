# Web toolkit

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install web-toolkit`; see [installation and scope](../../getting-started.md).

`web-toolkit search "<query>"` prints up to 10 result titles, URLs, and snippets; `site:` and `-site:` operators in the query are enforced as domain filters. `web-toolkit fetch <url>` prints a page as Markdown, a PDF as per-page text, and other text formats unchanged. Pages over 10,000 characters print their beginning and an outline of later headings with line numbers, and save the full text under `~/.harness/web-toolkit/pages/` for the agent to read or grep; saved pages are removed after a day. Neither command takes options.

Fetch tries plain HTTP with a browser-like fingerprint first. Bot challenges, blocked responses, pages with little text or an empty application root, and every search use one shared headless Chrome: the first command that needs it starts it with a dedicated profile, concurrent commands each work in their own tab, and it closes after 10 idle minutes. Search reads public engine result pages, trying DuckDuckGo, Startpage, Bing, and Google in that order and answering from the first engine whose results match the query. An installed Google Chrome or Microsoft Edge is required (or Chromium; set `WEB_TOOLKIT_BROWSER` to choose an executable). The browser state lives in `~/.harness/web-toolkit/` (or `$HARNESS_STATE_DIR/web-toolkit/`). Chrome runs without its own process sandbox, which cannot start inside agent sandboxes.

Installation adds the CLI. Claude Code and ChatGPT receive a skill that directs agents to use Web Toolkit for web searches and source reading. Pi receives the native `web_search` and `web_fetch` tools; restart Pi or reload extensions after installation. `web_search` takes one required string, `query`; `web_fetch` takes one required string, `url`. Both return `{ output: string, exitCode: integer }`, where `output` is the CLI text followed by any stderr. Nonzero exits are tool errors and preserve HTTP error pages. Calls have a 120-second deadline, a 256 KiB output limit, and support cancellation. The extension invokes the CLI directly with literal arguments and uses the current Pi working directory. It requires `web-toolkit` on Pi's PATH and works at project or user scope.

Pi's `web_search` also accepts optional `allowed_domains` and `blocked_domains` arrays, for example `{ "query": "asyncio TaskGroup", "allowed_domains": ["docs.python.org"], "blocked_domains": ["legacy.docs.python.org"] }`. Use bare domain names rather than URLs. Allowed domains match as alternatives, both filters include subdomains, and exclusions win. Empty arrays apply no restriction. Put website filters in these parameters when using them; combining them with inline `site:` operators is rejected to avoid conflicting restrictions. The CLI continues to accept its existing `site:` query syntax.

The native descriptions explain when to search, fetching sources before relying on excerpts, current-date queries, Markdown source citations, and treating retrieved content as untrusted data. Fetch returns document text for the calling agent to analyze, follows redirects, and supports explicit HTTP and private-network URLs. It uses a dedicated browser profile rather than the user's normal browser login; prefer an authenticated service tool or CLI for content requiring sign-in. Long-page files are saved extracted text, not a fetch-response cache.

A missing CLI returns a direct, pinned `uv tool install --force` command. Both native tools instruct the agent to attempt installation at most once per session. If that command fails, cannot run, or leaves the tools unavailable, the agent must treat both tools as unusable for the rest of the session, stop tool and installation retries, and report the limitation to the user in one sentence. Installation is an explicit agent action; the web tools themselves remain read-only.

Provider configuration remains user-owned. For ChatGPT sandboxed commands, configure network access and writable roots for uv's tool and Python directories and the browser state if needed; the Windows sandbox may otherwise be unable to reach the CLI installation. Search engines throttle bursts of automated queries; a throttled engine is skipped for that search.

## Pi implementation and verification

`web-toolkit` ships native `web_search(query)` and `web_fetch(url)` tools in
1.2.0, alongside its existing host CLI. Since version 1.2.1, Pi receives only the tools;
Claude Code and ChatGPT receive the skill directing agents to use Web Toolkit for web searches
and source reading. The Pi extension executes
the CLI with literal argv, a bounded output buffer and deadline, and abort propagation.
Version 1.3.0 adds native `allowed_domains` and `blocked_domains` arrays, translated to the
existing CLI's enforced domain filters. Allowed hosts match as alternatives, subdomains are
included and exclusions take precedence; mixing explicit filters with inline operators is
rejected before execution. Tool descriptions and native guidelines cover source reading,
citations, current-date searches, authentication limits and full-text file reuse.
Version 1.3.2 replaces installer-specific missing-CLI guidance with a direct pinned uv
installation command and shared agent instructions for one installation attempt followed
by session-wide unavailability and a one-sentence user notice on failure. This is agent
workflow guidance, not an extension-enforced ban on later calls.
Successful and nonzero CLI results carry `{ output, exitCode }` in structured content;
nonzero exits are tool errors preserving stdout, including HTTP error pages. It has no
session-state or Python bridge dependency. See the [acceptance journey](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-web-toolkit).
