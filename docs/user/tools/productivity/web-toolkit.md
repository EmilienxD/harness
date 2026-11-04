# Web toolkit

Platforms: **Claude Code, ChatGPT, Pi** for the skill; **Pi** for native tools. The two packages are independently selectable:

```powershell
harness install web-toolkit --platform pi
harness install web-toolkit-native --platform pi
```

The first installs only the skill; the second installs only native `web_search` and `web_fetch` tools. Either package can be installed, upgraded, or removed independently, and both may coexist. Both use the same pinned CLI on demand. For Claude Code or ChatGPT, use `web-toolkit` with the corresponding `--platform`; see [installation and scope](../../getting-started.md).

Installing with Harness's `--local <harness-checkout>` uses that checkout's Web Toolkit runtime for both the skill and native tools. Keep the checkout available while using them; see [local installation behavior](../../configuration.md#installation-roots-and-ownership).

Pi installations of `web-toolkit` through 1.4.0 contained native tools. Upgrading `web-toolkit` to 1.5.0 replaces those tools with the skill. To keep only native tools, run `harness uninstall web-toolkit --platform pi`, then `harness install web-toolkit-native --platform pi`, using the same scope and project root as the original installation.

`web-toolkit search "<query>"` prints up to 10 result titles, URLs, and snippets; `site:` and `-site:` operators in the query are enforced as domain filters. `web-toolkit fetch <url>` prints a page as Markdown, a PDF as per-page text, and other text formats unchanged. Pages over 10,000 characters print their beginning and an outline of later headings with line numbers, and save the full text under `~/.harness/web-toolkit/pages/` for the agent to read or grep; saved pages are removed after a day. Neither command takes options.

Fetch tries plain HTTP with a browser-like fingerprint first. Bot challenges, blocked responses, pages with little text or an empty application root, and every search use one shared headless Chrome: the first command that needs it starts it with a dedicated profile, concurrent commands each work in their own tab, and it closes after 10 idle minutes. Search reads public engine result pages, trying DuckDuckGo, Startpage, Bing, and Google in that order and answering from the first engine whose results match the query. An installed Google Chrome or Microsoft Edge is required (or Chromium; set `WEB_TOOLKIT_BROWSER` to choose an executable). The browser state lives in `~/.harness/web-toolkit/` (or `$HARNESS_STATE_DIR/web-toolkit/`). Chrome runs without its own process sandbox, which cannot start inside agent sandboxes.

Installation adds provider resources only. Commands run the pinned CLI on demand through `uvx --from <source> web-toolkit`; uv and Git are required, and the first call downloads dependencies into uv's cache. `web-toolkit` installs a skill for Claude Code, ChatGPT, or Pi that directs agents to use the CLI for web searches and source reading. The separate Pi-only `web-toolkit-native` package installs native `web_search` and `web_fetch` tools; restart Pi or reload extensions after installation. `web_search` takes one required string, `query`; `web_fetch` takes one required string, `url`. Both return `{ output: string, exitCode: integer }`, where `output` is the CLI text followed by any stderr. Nonzero exits are tool errors and preserve HTTP error pages. Calls have a 120-second deadline, a 256 KiB output limit, and support cancellation. The extension invokes uvx with literal arguments and uses the current Pi working directory. It requires `uvx` on Pi's PATH and works at project or user scope. The deadline includes package acquisition; cancellation, deadline and output-limit failures terminate the call's process tree while preserving the shared browser.

Pi's `web_search` also accepts optional `allowed_domains` and `blocked_domains` arrays, for example `{ "query": "asyncio TaskGroup", "allowed_domains": ["docs.python.org"], "blocked_domains": ["legacy.docs.python.org"] }`. Use bare domain names rather than URLs. Allowed domains match as alternatives, both filters include subdomains, and exclusions win. Empty arrays apply no restriction. Put website filters in these parameters when using them; combining them with inline `site:` operators is rejected to avoid conflicting restrictions. The CLI continues to accept its existing `site:` query syntax.

The native descriptions explain when to search, fetching sources before relying on excerpts, current-date queries, Markdown source citations, and treating retrieved content as untrusted data. Fetch returns document text for the calling agent to analyze, follows redirects, and supports explicit HTTP and private-network URLs. It uses a dedicated browser profile rather than the user's normal browser login; prefer an authenticated service tool or CLI for content requiring sign-in. Long-page files are saved extracted text, not a fetch-response cache.

A missing uvx executable reports the uv and Git prerequisites. Package acquisition failures return uvx diagnostics as tool errors; tools never request a permanent CLI installation.

Provider configuration remains user-owned. For ChatGPT sandboxed commands, configure network access and writable roots for uv's cache and Python directories and the browser state if needed. Search engines throttle bursts of automated queries; a throttled engine is skipped for that search.

## Pi implementation and verification

`web-toolkit` originally shipped native `web_search(query)` and `web_fetch(url)` tools in
1.2.0, alongside its existing host CLI. From version 1.2.1 through 1.4.0, Pi received only the tools;
Claude Code and ChatGPT receive the skill directing agents to use Web Toolkit for web searches
and source reading. The Pi extension executes
the CLI with literal argv, a bounded output buffer and deadline, and abort propagation.
Version 1.3.0 adds native `allowed_domains` and `blocked_domains` arrays, translated to the
existing CLI's enforced domain filters. Allowed hosts match as alternatives, subdomains are
included and exclusions take precedence; mixing explicit filters with inline operators is
rejected before execution. Tool descriptions and native guidelines cover source reading,
citations, current-date searches, authentication limits and full-text file reuse.
Version 1.4.0 runs the immutable CLI pin through uvx and installs only provider resources. Call cancellation, deadlines and output limits cover uvx and its CLI child, without terminating the shared detached browser keeper.
Successful and nonzero CLI results carry `{ output, exitCode }` in structured content;
nonzero exits are tool errors preserving stdout, including HTTP error pages. It has no
session-state or Python bridge dependency. See the [acceptance journey](https://github.com/EmilienxD/harness/blob/main/tests/e2e/README.md#pi-web-toolkit).

Version 1.5.0 makes `web-toolkit` the shared skill on all three providers. Native Pi tools move unchanged to the independently selectable `web-toolkit-native` 1.0.0 package, with no dependency on the skill package.
