# Chrome DevTools

Platforms: **Claude Code, ChatGPT, Pi**. Install with `harness install chrome-devtools`; see [installation and scope](../../getting-started.md).

```powershell
uv run harness install chrome-devtools --platform pi
# Also supports --platform claude or --platform chatgpt, and --scope user.
```

This optional integration installs Google's `chrome-devtools-mcp` npm package at version
`1.11.0`, exposing the `chrome-devtools` CLI, and the matching upstream
`chrome-devtools-cli` skill. Node.js `^20.19.0`, `^22.12.0`, or `>=23`, npm, and Google Chrome
are required. The CLI is experimental upstream. Harness forwards installation to npm; Google
maintains the browser implementation. The skill, Apache-2.0 license, and source provenance
are bundled; its manual installation reference is pinned to the same release.

Invoke `/chrome-devtools-cli` in Claude Code, `$chrome-devtools-cli` in ChatGPT/Codex, or
`/skill:chrome-devtools-cli` in Pi; the agent can also select the skill for browser work.
Restart the provider or run `/reload` in Pi to discover it. The skill uses shell commands;
installation adds no MCP server configuration or native browser tools.

The first browser command starts the upstream daemon, which retains pages across commands.
Use `chrome-devtools list_pages` to inspect it and `chrome-devtools stop` when finished.
Browser profiles, daemon state, and upstream telemetry settings remain upstream-owned.
See the [upstream CLI documentation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/a878bcad39584337e055778353246820deafa7c0/docs/cli.md)
for connection and browser options.

The CLI installs globally through npm even for project-scope skills. A pre-existing npm
installation is protected by Harness's host-product ownership check; use the menu's adoption
choice or add `--adopt` to the install command to explicitly transfer it to Harness. Adoption installs the
pinned version and makes Harness responsible for removal. Installs across providers and projects
share the host product; the last owning receipt removes it. `harness upgrade` follows the
catalogue pin rather than npm's `latest`. Stop the daemon before upgrading or uninstalling;
Harness leaves running browser sessions alone.

## Pi implementation and verification

`chrome-devtools` installs the pinned upstream `chrome-devtools-mcp` npm CLI
and matching `chrome-devtools-cli` skill at project and user scopes. It reuses shell tools,
without a Pi extension or MCP configuration. The real Pi acceptance journey verifies native
skill invocation, browser interaction and screenshot effects against a loopback page, exactly
three inference requests, and cross-provider receipt-driven host removal. Its npm prefix,
browser profile and daemon identity are isolated from personal installations.
