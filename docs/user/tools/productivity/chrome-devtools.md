# Chrome DevTools

Platforms: **Claude Code, ChatGPT, Pi**.

Install with `harness install chrome-devtools`. See [installation and scope](../../getting-started.md).

```powershell
harness install chrome-devtools --platform pi
# Also supports --platform claude or --platform chatgpt, and --scope user.
```

This optional integration installs Google's `chrome-devtools-mcp` npm package at version `1.11.0`, exposing the `chrome-devtools` CLI, and the matching upstream `chrome-devtools-cli` skill. Node.js `^20.19.0`, `^22.12.0`, or `>=23`, npm, and Google Chrome are required. The CLI is experimental upstream. Harness forwards installation to npm.  Google maintains the browser implementation.

Invoke `/chrome-devtools-cli` in Claude Code, `$chrome-devtools-cli` in ChatGPT/Codex, or `/skill:chrome-devtools-cli` in Pi. The agent can also select the skill for browser work. Restart the provider or run `/reload` in Pi to discover it. The skill uses shell commands. Installation adds no MCP server configuration or native browser tools.

The first browser command starts the upstream daemon, which retains pages across commands. Use `chrome-devtools list_pages` to inspect it and `chrome-devtools stop` when finished. Browser profiles, daemon state, and upstream telemetry settings remain upstream-owned.

See the [upstream CLI documentation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/a878bcad39584337e055778353246820deafa7c0/docs/cli.md) for connection and browser options.
